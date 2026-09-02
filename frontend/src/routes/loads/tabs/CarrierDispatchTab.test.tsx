import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import { CarrierDispatchTab } from './CarrierDispatchTab';
import type { Load } from '../../../api';

const DOC_TYPES = [
  {
    id: 'dt-rc',
    organizationId: null,
    category: 'LOAD',
    code: 'RATE_CONFIRMATION',
    label: 'Rate Confirmation',
    requiresReview: false,
    isSystemDefault: true,
  },
];

function makeLoad(overrides: Partial<Load> = {}): Load {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000001',
    customerId: 'cust-1',
    bookingSource: 'DIRECT',
    status: 'DISPATCHED',
    equipmentType: 'DRY_VAN',
    customerRate: '1000',
    rateSource: 'MANUAL',
    rateAgreementId: null,
    assignedCarrierId: 'carrier-1',
    carrierRate: '900',
    podStatus: 'NOT_RECEIVED',
    riskStatus: 'NORMAL',
    invoiced: false,
    createdByUserId: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stops: [],
    sourcingAttempts: [],
    dispatchRecord: null,
    checkCalls: [],
    chargeLineItems: [],
    ...overrides,
  };
}

const DISPATCH_RECORD = {
  loadId: 'load-1',
  driverName: 'Julia',
  driverPhone: '(773) 870-1332',
  truckNumber: 'T-1',
  trailerNumber: 'TR-1',
  dispatchedByUserId: 'user-1',
  dispatchedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderTab(load: Load) {
  server.use(
    http.get('/api/v1/carriers', () =>
      HttpResponse.json([{ id: 'carrier-1', legalName: 'MG CARGO INC' }]),
    ),
    http.get('/api/v1/memberships', () =>
      HttpResponse.json([{ userId: 'user-1', user: { name: 'Jane Dispatcher' } }]),
    ),
    http.get('/api/v1/document-types', () => HttpResponse.json(DOC_TYPES)),
    http.get('/api/v1/documents', () => HttpResponse.json([])),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CarrierDispatchTab load={load} onChanged={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('CarrierDispatchTab — Driver Dispatch Email feature', () => {
  it('does not show the Send Driver Dispatch Email button when there is no dispatchRecord', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderTab(makeLoad({ dispatchRecord: null }));

    await screen.findByText('Not yet dispatched.');
    expect(screen.queryByText('Send Driver Dispatch Email')).not.toBeInTheDocument();
  });

  it('shows the Send Driver Dispatch Email button once a dispatchRecord exists, for a permitted role', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderTab(makeLoad({ dispatchRecord: DISPATCH_RECORD }));

    await screen.findByText(/Julia — \(773\) 870-1332/);
    expect(screen.getByText('Send Driver Dispatch Email')).toBeInTheDocument();
  });

  it('hides the button for a role without sourceAndDispatchLoads permission, even with a dispatchRecord', async () => {
    useSessionStore.setState({ roles: ['ACCOUNTING'] });
    renderTab(makeLoad({ dispatchRecord: DISPATCH_RECORD }));

    await screen.findByText(/Julia — \(773\) 870-1332/);
    expect(screen.queryByText('Send Driver Dispatch Email')).not.toBeInTheDocument();
  });

  it('existing Carrier & Dispatch functionality (sourcing attempts, current assignment, rate confirmation) is unchanged', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderTab(
      makeLoad({
        dispatchRecord: DISPATCH_RECORD,
        sourcingAttempts: [
          {
            id: 'attempt-1',
            loadId: 'load-1',
            carrierId: 'carrier-1',
            carrierRate: '900',
            outcome: 'ASSIGNED',
            loggedByUserId: 'user-1',
            loggedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(screen.getByText('Carrier Sourcing Attempts')).toBeInTheDocument();
    await screen.findAllByText('MG CARGO INC');
    expect(screen.getByText('Current Assignment')).toBeInTheDocument();
    expect(screen.getByText('Rate Confirmation')).toBeInTheDocument();
    expect(screen.getByText('Not yet generated.')).toBeInTheDocument();
    expect(screen.getByText('Dispatch Record')).toBeInTheDocument();
  });
});
