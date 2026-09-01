import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport, useToastStore } from '../../components/ui';
import { CarrierDetailPage } from './CarrierDetailPage';
import type { Carrier } from '../../api';

const CARRIER: Carrier = {
  id: 'carrier-1',
  legalName: 'MG Cargo Inc',
  dba: '',
  mcNumber: '042939',
  dotNumber: '1234567',
  addressLine1: '200 Dock Rd',
  city: 'Tampa',
  state: 'FL',
  zip: '33602',
  primaryContactName: 'Sam Broker',
  primaryContactPhone: '555-0200',
  primaryContactEmail: 'sam@mgcargo.test',
  status: 'ACTIVE',
  assignmentEligible: true,
  ineligibilityReasons: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  contacts: [],
  insuranceRecords: [],
  fmcsaVerifications: [],
  serviceAreas: [],
  factoringInfo: null,
  drivers: [],
  trucks: [],
  trailers: [],
};

function renderPage(carrierId = CARRIER.id) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/carriers/${carrierId}`]}>
        <Routes>
          <Route path="/carriers/:id" element={<CarrierDetailPage />} />
        </Routes>
      </MemoryRouter>
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('CarrierDetailPage — Edit/Save', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
    useToastStore.setState({ toasts: [] });
  });

  it('loads and populates the edit form with the fetched carrier values', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(http.get('/api/v1/carriers/carrier-1', () => HttpResponse.json(CARRIER)));

    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));

    expect(screen.getByDisplayValue('MG Cargo Inc')).toBeInTheDocument();
    expect(screen.getByDisplayValue('200 Dock Rd')).toBeInTheDocument();
    expect(screen.getByDisplayValue('sam@mgcargo.test')).toBeInTheDocument();
  });

  it('submits only the UpdateCarrierDto fields, never id/mcNumber/dotNumber/status/relations', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/v1/carriers/carrier-1', () => HttpResponse.json(CARRIER)),
      http.patch('/api/v1/carriers/carrier-1', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...CARRIER, dba: 'MGC Express' });
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));

    fireEvent.change(screen.getByLabelText('DBA'), { target: { value: 'MGC Express' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(receivedBody).toBeDefined());
    expect(receivedBody).toEqual({
      legalName: CARRIER.legalName,
      dba: 'MGC Express',
      addressLine1: CARRIER.addressLine1,
      city: CARRIER.city,
      state: CARRIER.state,
      zip: CARRIER.zip,
      primaryContactName: CARRIER.primaryContactName,
      primaryContactPhone: CARRIER.primaryContactPhone,
      primaryContactEmail: CARRIER.primaryContactEmail,
    });
    for (const forbidden of [
      'id',
      'organizationId',
      'mcNumber',
      'dotNumber',
      'status',
      'assignmentEligible',
      'ineligibilityReasons',
      'createdByUserId',
      'createdAt',
      'contacts',
      'insuranceRecords',
      'fmcsaVerifications',
      'serviceAreas',
      'factoringInfo',
      'drivers',
      'trucks',
      'trailers',
    ]) {
      expect(receivedBody).not.toHaveProperty(forbidden);
    }
  });

  it('closes the modal and refreshes the carrier on a successful save', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let currentCarrier = CARRIER;
    server.use(
      http.get('/api/v1/carriers/carrier-1', () => HttpResponse.json(currentCarrier)),
      http.patch('/api/v1/carriers/carrier-1', () => {
        currentCarrier = { ...currentCarrier, dba: 'MGC Express' };
        return HttpResponse.json(currentCarrier);
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Carrier updated.')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('sam@mgcargo.test')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'MG Cargo Inc (DBA: MGC Express)' }),
      ).toBeInTheDocument(),
    );
  });

  it('shows the API error and keeps the modal open with the edited value on a failed save', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/carriers/carrier-1', () => HttpResponse.json(CARRIER)),
      http.patch('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json(
          { error: { code: 'BAD_REQUEST', message: 'dba must be a string' } },
          { status: 400 },
        ),
      ),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Edit'));

    fireEvent.change(screen.getByLabelText('DBA'), { target: { value: 'Broken DBA' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('dba must be a string')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Broken DBA')).toBeInTheDocument();
  });
});
