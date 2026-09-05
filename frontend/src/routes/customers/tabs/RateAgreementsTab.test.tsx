import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import { ToastViewport } from '../../../components/ui';
import { RateAgreementsTab } from './RateAgreementsTab';
import type { Customer } from '../../../api';

const CUSTOMER: Customer = {
  id: 'cust-1',
  legalName: 'Scotlynn',
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
  rateAgreements: [],
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RateAgreementsTab customer={CUSTOMER} />
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('RateAgreementsTab — Add Rate Agreement failure handling (Task #5)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('shows a toast error and keeps the modal open when the add request fails, and never shows success', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/customers/cust-1/rate-agreements', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderTab();

    fireEvent.click(screen.getByText('+ Add Rate Agreement'));
    fireEvent.change(screen.getByLabelText(/^Origin City/), { target: { value: 'Dallas' } });
    fireEvent.change(screen.getByLabelText(/^Origin State/), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText(/^Destination City/), { target: { value: 'Atlanta' } });
    fireEvent.change(screen.getByLabelText(/^Destination State/), { target: { value: 'GA' } });
    fireEvent.change(screen.getByLabelText(/^Rate\*?$/), { target: { value: '2000' } });
    fireEvent.change(screen.getByLabelText(/^Rate Type/), { target: { value: 'FLAT' } });
    fireEvent.change(screen.getByLabelText(/^Effective Date/), {
      target: { value: '2026-01-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Rate Agreement' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Dallas')).toBeInTheDocument();
    expect(screen.queryByText('Rate agreement added.')).not.toBeInTheDocument();
  });
});
