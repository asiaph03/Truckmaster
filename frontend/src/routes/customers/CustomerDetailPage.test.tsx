import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport, useToastStore } from '../../components/ui';
import { CustomerDetailPage } from './CustomerDetailPage';
import type { Customer } from '../../api';

const CUSTOMER: Customer = {
  id: 'cust-1',
  legalName: 'Scotlynn ',
  billingAddressLine1: '100 Freight Way',
  billingCity: 'Fort Myers',
  billingState: 'FL',
  billingZip: '33901',
  billingCountry: 'US',
  primaryContactName: 'Jane Shipper',
  primaryContactEmail: 'jane@scotlynn.test',
  primaryContactPhone: '555-0100',
  paymentTerms: 'NET_30',
  paymentTermsSource: 'INHERITED',
  status: 'ACTIVE',
  createdByUserId: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  contacts: [],
  locations: [],
  rateAgreements: [],
};

function renderPage(customerId = CUSTOMER.id) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/customers/${customerId}`]}>
        <Routes>
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
        </Routes>
      </MemoryRouter>
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('CustomerDetailPage — Edit/Save', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
    useToastStore.setState({ toasts: [] });
  });

  it('loads and populates the edit form with the fetched customer values', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(http.get('/api/v1/customers/cust-1', () => HttpResponse.json(CUSTOMER)));

    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Scotlynn' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));

    expect(screen.getByDisplayValue('Scotlynn')).toBeInTheDocument();
    expect(screen.getByDisplayValue('100 Freight Way')).toBeInTheDocument();
    expect(screen.getByDisplayValue('jane@scotlynn.test')).toBeInTheDocument();
  });

  it('submits only the UpdateCustomerDto fields, never id/status/timestamps/relations', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/v1/customers/cust-1', () => HttpResponse.json(CUSTOMER)),
      http.patch('/api/v1/customers/cust-1', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...CUSTOMER, legalName: 'Scotlynn Logistics' });
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Scotlynn' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));

    fireEvent.change(screen.getByDisplayValue('Scotlynn'), {
      target: { value: 'Scotlynn Logistics' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(receivedBody).toBeDefined());
    expect(receivedBody).toEqual({
      legalName: 'Scotlynn Logistics',
      billingAddressLine1: CUSTOMER.billingAddressLine1,
      billingCity: CUSTOMER.billingCity,
      billingState: CUSTOMER.billingState,
      billingZip: CUSTOMER.billingZip,
      primaryContactName: CUSTOMER.primaryContactName,
      primaryContactEmail: CUSTOMER.primaryContactEmail,
      primaryContactPhone: CUSTOMER.primaryContactPhone,
    });
    for (const forbidden of [
      'id',
      'organizationId',
      'status',
      'paymentTermsSource',
      'createdByUserId',
      'createdAt',
      'contacts',
      'locations',
      'rateAgreements',
    ]) {
      expect(receivedBody).not.toHaveProperty(forbidden);
    }
  });

  it('closes the modal and refreshes the customer on a successful save', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let currentCustomer = CUSTOMER;
    server.use(
      http.get('/api/v1/customers/cust-1', () => HttpResponse.json(currentCustomer)),
      http.patch('/api/v1/customers/cust-1', () => {
        currentCustomer = { ...currentCustomer, legalName: 'Scotlynn Logistics' };
        return HttpResponse.json(currentCustomer);
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Scotlynn' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Customer updated.')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('Scotlynn')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Scotlynn Logistics' })).toBeInTheDocument(),
    );
  });

  it('shows the API error and keeps the modal open with the edited value on a failed save', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/customers/cust-1', () => HttpResponse.json(CUSTOMER)),
      http.patch('/api/v1/customers/cust-1', () =>
        HttpResponse.json(
          { error: { code: 'BAD_REQUEST', message: 'legalName must be a string' } },
          { status: 400 },
        ),
      ),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Scotlynn' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));

    fireEvent.change(screen.getByDisplayValue('Scotlynn'), {
      target: { value: 'Broken Name' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('legalName must be a string')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Broken Name')).toBeInTheDocument();
  });
});
