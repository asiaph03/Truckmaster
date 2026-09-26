import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { OverviewTab } from './OverviewTab';
import { useSessionStore } from '../../../auth/session-store';
import type { Load, Stop } from '../../../api';

// Dashboard Map Phase — `LoadRouteMap` mounts a real Leaflet map, which
// (like every Leaflet consumer) cannot run in jsdom: Leaflet expects real
// browser layout/canvas APIs jsdom doesn't implement, a well-known,
// industry-wide limitation of testing map libraries outside a real
// browser — not specific to this component. Stubbed here so this file's
// existing Overview-tab assertions (unrelated to the map) keep working;
// the map's own logic (geocoding, marker/line derivation, popup
// escaping) is unit-tested directly in `components/map/*.test.ts(x)`,
// and its visual behavior is verified in a real browser instead.
vi.mock('../../../components/map', () => ({
  LoadRouteMap: () => <div data-testid="load-route-map-stub" />,
}));

const CUSTOMER = { id: 'cust-1', legalName: 'Acme Freight' };

function setRoles(roles: string[]) {
  useSessionStore.setState({ roles: roles as never });
}

function makeStop(overrides: Partial<Stop>): Stop {
  return {
    id: `stop-${overrides.sequence}`,
    loadId: 'load-1',
    sequence: 1,
    stopType: 'PICKUP',
    stopPurpose: 'STANDARD',
    companyName: 'Test Co',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    status: 'PENDING',
    ...overrides,
  };
}

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

function renderTab(load: Load) {
  server.use(
    http.get('/api/v1/customers/:id', () => HttpResponse.json(CUSTOMER)),
    http.get('/api/v1/memberships', () => HttpResponse.json([])),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <OverviewTab load={load} onChanged={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('OverviewTab — Stops card timestamp semantics', () => {
  beforeEach(() => {
    // DISPATCHER has no `viewLoadFinancials`, keeping the Financial
    // Summary and Closing Readiness cards (and its checklist fetch) out
    // of the way — irrelevant to the Stops card under test here.
    setRoles(['DISPATCHER']);
  });

  it('shows appointmentDatetime for a PENDING stop with no actual times', () => {
    const load = makeLoad({
      stops: [
        makeStop({
          sequence: 1,
          status: 'PENDING',
          appointmentDatetime: '2026-09-23T10:30:00.000Z', // Sep 23 6:30 AM EDT
          actualArrival: undefined,
          actualDeparture: undefined,
        }),
      ],
    });
    renderTab(load);

    expect(screen.getByText('Sep 23, 6:30 AM')).toBeInTheDocument();
  });

  it('shows appointmentDatetime (not actualDeparture) for a COMPLETED stop', () => {
    const load = makeLoad({
      stops: [
        makeStop({
          sequence: 1,
          status: 'COMPLETED',
          appointmentDatetime: '2026-09-21T19:00:00.000Z', // Sep 21 3:00 PM EDT
          actualArrival: '2026-09-21T20:00:00.000Z', // Sep 21 4:00 PM EDT
          actualDeparture: '2026-09-22T11:09:00.000Z', // Sep 22 7:09 AM EDT
        }),
      ],
    });
    renderTab(load);

    expect(screen.getByText('Sep 21, 3:00 PM')).toBeInTheDocument();
    expect(screen.queryByText('Sep 22, 7:09 AM')).not.toBeInTheDocument();
  });

  it('shows appointmentDatetime (not actualArrival) for an ARRIVED stop', () => {
    const load = makeLoad({
      stops: [
        makeStop({
          sequence: 1,
          status: 'ARRIVED',
          appointmentDatetime: '2026-09-21T19:00:00.000Z', // Sep 21 3:00 PM EDT
          actualArrival: '2026-09-21T20:00:00.000Z', // Sep 21 4:00 PM EDT
          actualDeparture: undefined,
        }),
      ],
    });
    renderTab(load);

    expect(screen.getByText('Sep 21, 3:00 PM')).toBeInTheDocument();
    expect(screen.queryByText('Sep 21, 4:00 PM')).not.toBeInTheDocument();
  });

  it('renders "—" when a stop has no appointmentDatetime at all', () => {
    const load = makeLoad({
      stops: [
        makeStop({
          sequence: 1,
          status: 'PENDING',
          appointmentDatetime: undefined,
          actualArrival: undefined,
          actualDeparture: undefined,
        }),
      ],
    });
    renderTab(load);

    const row = screen.getByText('Stop 1').closest('.load-stop-mini-row') as HTMLElement;
    expect(row).toHaveTextContent('—');
  });
});
