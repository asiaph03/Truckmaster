import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

describe('CarrierDetailPage — Block/Deactivate/Reactivate — Task #3', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
    useToastStore.setState({ toasts: [] });
  });

  it('ACTIVE shows Block Carrier and Deactivate Carrier, not Activate/Reactivate', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({ ...CARRIER, status: 'ACTIVE' }),
      ),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );

    expect(screen.getByText('Block Carrier')).toBeInTheDocument();
    expect(screen.getByText('Deactivate Carrier')).toBeInTheDocument();
    expect(screen.queryByText('Activate Carrier')).not.toBeInTheDocument();
    expect(screen.queryByText('Reactivate Carrier')).not.toBeInTheDocument();
  });

  it('INACTIVE shows Reactivate Carrier only', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({ ...CARRIER, status: 'INACTIVE' }),
      ),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );

    expect(screen.getByText('Reactivate Carrier')).toBeInTheDocument();
    expect(screen.queryByText('Block Carrier')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate Carrier')).not.toBeInTheDocument();
    expect(screen.queryByText('Activate Carrier')).not.toBeInTheDocument();
  });

  it('BLOCKED shows Reactivate Carrier only', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({ ...CARRIER, status: 'BLOCKED' }),
      ),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );

    expect(screen.getByText('Reactivate Carrier')).toBeInTheDocument();
    expect(screen.queryByText('Block Carrier')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate Carrier')).not.toBeInTheDocument();
  });

  it('PENDING still shows only Activate Carrier — unchanged by Task #3', async () => {
    useSessionStore.setState({ roles: ['ADMIN', 'COMPLIANCE_REVIEWER'] });
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({
          ...CARRIER,
          status: 'PENDING',
          assignmentEligible: false,
          activationReady: true,
          activationReasons: [],
        }),
      ),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );

    expect(screen.getByText('Activate Carrier')).toBeInTheDocument();
    expect(screen.queryByText('Block Carrier')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate Carrier')).not.toBeInTheDocument();
    expect(screen.queryByText('Reactivate Carrier')).not.toBeInTheDocument();
  });

  it('Block requires a reason — confirming with no reason never calls the API', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let called = false;
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({ ...CARRIER, status: 'ACTIVE' }),
      ),
      http.post('/api/v1/carriers/carrier-1/block', () => {
        called = true;
        return HttpResponse.json({ ...CARRIER, status: 'BLOCKED' });
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Block Carrier'));
    await waitFor(() => expect(screen.getByLabelText(/Reason/)).toBeInTheDocument());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Block Carrier' }),
    );

    expect(called).toBe(false);
  });

  it('Deactivate requires a reason — confirming with no reason never calls the API', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let called = false;
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({ ...CARRIER, status: 'ACTIVE' }),
      ),
      http.post('/api/v1/carriers/carrier-1/deactivate', () => {
        called = true;
        return HttpResponse.json({ ...CARRIER, status: 'INACTIVE' });
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Deactivate Carrier'));
    await waitFor(() => expect(screen.getByLabelText(/Reason/)).toBeInTheDocument());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate Carrier' }),
    );

    expect(called).toBe(false);
  });

  it('Reactivate requires a reason — confirming with no reason never calls the API', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let called = false;
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({ ...CARRIER, status: 'BLOCKED' }),
      ),
      http.post('/api/v1/carriers/carrier-1/reactivate', () => {
        called = true;
        return HttpResponse.json({ ...CARRIER, status: 'ACTIVE' });
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Reactivate Carrier'));
    await waitFor(() => expect(screen.getByLabelText(/Reason/)).toBeInTheDocument());
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reactivate Carrier' }),
    );

    expect(called).toBe(false);
  });

  it('a successful Block sends the reason, refetches, updates the status badge, and shows a toast', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let receivedBody: Record<string, unknown> | undefined;
    let currentCarrier: Carrier = { ...CARRIER, status: 'ACTIVE' };
    server.use(
      http.get('/api/v1/carriers/carrier-1', () => HttpResponse.json(currentCarrier)),
      http.post('/api/v1/carriers/carrier-1/block', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        currentCarrier = { ...currentCarrier, status: 'BLOCKED' };
        return HttpResponse.json(currentCarrier);
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Block Carrier'));
    await waitFor(() => expect(screen.getByLabelText(/Reason/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Insurance lapsed' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Block Carrier' }),
    );

    await waitFor(() => expect(screen.getByText('Carrier blocked.')).toBeInTheDocument());
    expect(receivedBody).toEqual({ reason: 'Insurance lapsed' });
    await waitFor(() => expect(screen.getByText('BLOCKED')).toBeInTheDocument());
    expect(screen.getByText('Reactivate Carrier')).toBeInTheDocument();
  });

  it('a failed Deactivate shows the API error via toast and does not silently swallow it', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/carriers/carrier-1', () =>
        HttpResponse.json({ ...CARRIER, status: 'ACTIVE' }),
      ),
      http.post('/api/v1/carriers/carrier-1/deactivate', () =>
        HttpResponse.json(
          {
            error: {
              code: 'BUSINESS_RULE_ERROR',
              message: 'Only an Active carrier can be deactivated.',
            },
          },
          { status: 409 },
        ),
      ),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Deactivate Carrier'));
    await waitFor(() => expect(screen.getByLabelText(/Reason/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Test reason' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate Carrier' }),
    );

    await waitFor(() =>
      expect(screen.getByText('Only an Active carrier can be deactivated.')).toBeInTheDocument(),
    );
    // Status badge is unchanged — the failure never silently applied.
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('Activate Carrier (PENDING) behavior is unaffected by Task #3', async () => {
    useSessionStore.setState({ roles: ['ADMIN', 'COMPLIANCE_REVIEWER'] });
    let currentCarrier: Carrier = {
      ...CARRIER,
      status: 'PENDING',
      assignmentEligible: false,
      activationReady: true,
      activationReasons: [],
    };
    server.use(
      http.get('/api/v1/carriers/carrier-1', () => HttpResponse.json(currentCarrier)),
      http.post('/api/v1/carriers/carrier-1/activate', () => {
        currentCarrier = { ...currentCarrier, status: 'ACTIVE' };
        return HttpResponse.json(currentCarrier);
      }),
    );

    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'MG Cargo Inc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Activate Carrier'));

    await waitFor(() => expect(screen.getByText('Carrier activated.')).toBeInTheDocument());
  });
});
