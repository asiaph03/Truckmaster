import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { AccessorialChargesCard } from './AccessorialChargesCard';
import type { ChargeLineItem, Load } from '../../api';

const CHARGE_TYPES = [
  {
    id: 'ct-linehaul',
    organizationId: null,
    code: 'LINEHAUL',
    label: 'Linehaul',
    isSystemDefault: true,
  },
  {
    id: 'ct-detention',
    organizationId: null,
    code: 'DETENTION',
    label: 'Detention',
    isSystemDefault: true,
  },
];

function makeCharge(overrides: Partial<ChargeLineItem> = {}): ChargeLineItem {
  return {
    id: 'charge-1',
    loadId: 'load-1',
    side: 'CUSTOMER',
    chargeTypeId: 'ct-detention',
    quantity: '1',
    unitRate: '200.00',
    amount: '200.00',
    source: 'ADJUSTMENT',
    notes: 'Detained 3 hours at pickup',
    createdByUserId: 'user-dispatcher',
    createdAt: '2026-09-04T12:00:00.000Z',
    ...overrides,
  };
}

function makeLoad(overrides: Partial<Load> = {}): Load {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000001',
    customerId: 'cust-1',
    bookingSource: 'DIRECT',
    status: 'IN_TRANSIT',
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

function renderCard(load: Load, onChanged: () => void = () => {}) {
  server.use(
    http.get('/api/v1/charge-types', () => HttpResponse.json(CHARGE_TYPES)),
    http.get('/api/v1/memberships', () =>
      HttpResponse.json([{ userId: 'user-dispatcher', user: { name: 'Jane Dispatcher' } }]),
    ),
    http.post('/api/v1/loads/:id/charges', () =>
      HttpResponse.json(makeCharge({ id: 'charge-2' }), { status: 201 }),
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccessorialChargesCard load={load} onChanged={onChanged} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AccessorialChargesCard — Accessorial Charges on in-transit Loads', () => {
  it('lists only source=ADJUSTMENT charges, never the ORIGINAL linehaul row', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderCard(
      makeLoad({
        chargeLineItems: [
          makeCharge({ id: 'original-linehaul', source: 'ORIGINAL', chargeTypeId: 'ct-linehaul' }),
          makeCharge({ id: 'accessorial-1', source: 'ADJUSTMENT' }),
        ],
      }),
    );

    await screen.findByText('Detention');
    expect(screen.queryByText('Linehaul')).not.toBeInTheDocument();
  });

  it('renders "—" for a redacted (null) amount rather than $0.00 or crashing', async () => {
    useSessionStore.setState({ roles: ['DISPATCHER'] });
    renderCard(
      makeLoad({
        chargeLineItems: [makeCharge({ amount: null, side: 'CARRIER' })],
      }),
    );

    await screen.findByText('Detention');
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('Dispatcher sees the "+ Add Charge" button here, without needing the (hidden-for-them) Financials tab', async () => {
    useSessionStore.setState({ roles: ['DISPATCHER'] });
    renderCard(makeLoad());

    expect(await screen.findByText('+ Add Charge')).toBeInTheDocument();
  });

  it('hides "+ Add Charge" for a role without addChargeToLoad permission', async () => {
    useSessionStore.setState({ roles: ['COMPLIANCE_REVIEWER'] });
    renderCard(makeLoad());

    await screen.findByText('No accessorial charges yet.');
    expect(screen.queryByText('+ Add Charge')).not.toBeInTheDocument();
  });

  it('adding a charge calls onChanged, matching the existing Financials-tab Add Charge flow', async () => {
    useSessionStore.setState({ roles: ['DISPATCHER'] });
    let changed = false;
    renderCard(makeLoad(), () => {
      changed = true;
    });

    fireEvent.click(await screen.findByText('+ Add Charge'));
    await screen.findByRole('heading', { name: 'Add Charge' });

    fireEvent.change(screen.getByLabelText(/^Charge Type/), { target: { value: 'ct-detention' } });
    fireEvent.change(screen.getByLabelText(/^Unit Rate/), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Charge' }));

    await waitFor(() => expect(changed).toBe(true));
  });
});
