import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { StopsTrackingTab } from './StopsTrackingTab';
import { useSessionStore } from '../../../auth/session-store';
import type { CheckCall, Load, Stop } from '../../../api';

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

function makeCheckCall(overrides: Partial<CheckCall> = {}): CheckCall {
  return {
    id: 'cc-1',
    loadId: 'load-1',
    loggedByUserId: 'user-1',
    occurredAt: '2026-09-02T19:54:00.000Z',
    contactMethod: 'Phone',
    personContacted: 'Quo Test',
    locationCity: 'New Work',
    locationState: 'US',
    onTimeStatus: 'ON_TIME',
    ...overrides,
  };
}

function makeLoad(overrides: Partial<Load>): Load {
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
    http.get('/api/v1/memberships', () =>
      HttpResponse.json([{ userId: 'user-1', user: { name: 'Jane Dispatcher' } }]),
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <StopsTrackingTab load={load} onChanged={() => {}} />
    </QueryClientProvider>,
  );
}

describe('StopsTrackingTab — Return Product feature', () => {
  beforeEach(() => {
    setRoles(['ADMIN']);
  });

  it('shows a "Return" sub-badge only on stopPurpose: RETURN stops', () => {
    const load = makeLoad({
      status: 'DELIVERED',
      stops: [
        makeStop({ sequence: 1, stopType: 'PICKUP', stopPurpose: 'STANDARD' }),
        makeStop({ sequence: 2, stopType: 'DELIVERY', stopPurpose: 'STANDARD' }),
        makeStop({ sequence: 3, stopType: 'PICKUP', stopPurpose: 'RETURN' }),
        makeStop({ sequence: 4, stopType: 'DELIVERY', stopPurpose: 'RETURN' }),
      ],
    });
    renderTab(load);

    expect(screen.getAllByText('Return')).toHaveLength(2);
  });

  it('hides the "+ Initiate Return" action entirely for a role without sourceAndDispatchLoads', () => {
    setRoles(['SALES_BOOKING']);
    const load = makeLoad({ status: 'DELIVERED' });
    renderTab(load);

    expect(screen.queryByText('+ Initiate Return')).not.toBeInTheDocument();
  });

  it('disables "+ Initiate Return" with a tooltip on a pre-Dispatch (BOOKED) Load', () => {
    const load = makeLoad({ status: 'BOOKED' });
    renderTab(load);

    const button = screen.getByText('+ Initiate Return').closest('button') as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button.title).toMatch(/Dispatched/);
  });

  it('enables "+ Initiate Return" on a DELIVERED Load and opens the modal on click', () => {
    const load = makeLoad({ status: 'DELIVERED' });
    renderTab(load);

    const button = screen.getByText('+ Initiate Return').closest('button') as HTMLButtonElement;
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(screen.getByText('Return Pickup')).toBeInTheDocument();
    expect(screen.getByText('Return Delivery')).toBeInTheDocument();
  });

  it('enables "+ Initiate Return" on an IN_TRANSIT Load (still Dispatched, not yet Delivered)', () => {
    const load = makeLoad({ status: 'IN_TRANSIT' });
    renderTab(load);

    const button = screen.getByText('+ Initiate Return').closest('button') as HTMLButtonElement;
    expect(button).not.toBeDisabled();
  });
});

describe('StopsTrackingTab — Check Call row click → details drawer', () => {
  beforeEach(() => {
    setRoles(['ADMIN']);
  });

  it('renders each Check Call row as clickable (hover/clickable affordance) without changing the existing row content', () => {
    const load = makeLoad({
      checkCalls: [
        makeCheckCall({ id: 'cc-1', contactMethod: 'Phone', personContacted: 'Quo Test' }),
      ],
    });
    renderTab(load);

    const row = screen.getByText('Quo Test').closest('.load-stop-mini-row') as HTMLElement;
    expect(row).toHaveClass('load-stop-mini-row-clickable');
    // Existing row content is unchanged: time, contact method, person, location, status badge.
    expect(row).toHaveTextContent('Phone');
    expect(row).toHaveTextContent('Quo Test');
    expect(row).toHaveTextContent('New Work, US');
    expect(row).toHaveTextContent('ON TIME');
  });

  it('opens a Check Call Details drawer on row click, without navigating away from the Load page', () => {
    const load = makeLoad({ checkCalls: [makeCheckCall({ id: 'cc-1' })] });
    renderTab(load);

    expect(screen.queryByText('Check Call Details')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Quo Test'));

    expect(screen.getByText('Check Call Details')).toBeInTheDocument();
    // The Load page underneath is still rendered — Check Calls header still present.
    expect(screen.getByText('Check Calls')).toBeInTheDocument();
  });

  it("shows the clicked row's own details — date/time, driver, location, status", () => {
    const load = makeLoad({
      checkCalls: [
        makeCheckCall({
          id: 'cc-1',
          occurredAt: '2026-09-02T19:54:00.000Z',
          personContacted: 'Quo Test',
          locationCity: 'New Work',
          locationState: 'US',
          onTimeStatus: 'ON_TIME',
        }),
      ],
    });
    renderTab(load);

    fireEvent.click(screen.getByText('Quo Test'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Date & Time')).toBeInTheDocument();
    expect(within(dialog).getByText('Location')).toBeInTheDocument();
    expect(within(dialog).getByText('New Work, US')).toBeInTheDocument();
    expect(within(dialog).getByText('ON TIME')).toBeInTheDocument();
  });

  it('opens the correct corresponding details for each of several Check Calls', () => {
    const load = makeLoad({
      checkCalls: [
        makeCheckCall({
          id: 'cc-1',
          occurredAt: '2026-09-02T19:54:00.000Z',
          personContacted: 'Quo Test',
          onTimeStatus: 'ON_TIME',
        }),
        makeCheckCall({
          id: 'cc-2',
          occurredAt: '2026-09-02T17:29:00.000Z',
          personContacted: 'QUO',
          contactMethod: 'Fax',
          locationCity: undefined,
          locationState: undefined,
          onTimeStatus: 'UNKNOWN',
        }),
      ],
    });
    renderTab(load);

    fireEvent.click(screen.getByText('QUO'));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('QUO')).toBeInTheDocument();
    expect(within(dialog).getByText('UNKNOWN')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Quo Test'));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Quo Test')).toBeInTheDocument();
    expect(within(dialog).getByText('ON TIME')).toBeInTheDocument();
    expect(within(dialog).queryByText('UNKNOWN')).not.toBeInTheDocument();
  });

  it('closes the drawer via the close button', () => {
    const load = makeLoad({ checkCalls: [makeCheckCall({ id: 'cc-1' })] });
    renderTab(load);

    fireEvent.click(screen.getByText('Quo Test'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('leaves the existing "+ Log Check Call" action and modal unaffected by the new row-click behavior', () => {
    const load = makeLoad({
      status: 'DISPATCHED',
      checkCalls: [makeCheckCall({ id: 'cc-1' })],
    });
    renderTab(load);

    // Opening a Check Call's details drawer does not open the Log Check Call modal.
    fireEvent.click(screen.getByText('Quo Test'));
    expect(screen.queryByText('Log Check Call')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));

    // The existing "+ Log Check Call" button still opens its own modal, unchanged.
    fireEvent.click(screen.getByText('+ Log Check Call'));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Log Check Call');
  });

  it('never renders "undefined" or "null" for genuinely missing optional fields — shows "—" instead', () => {
    const load = makeLoad({
      checkCalls: [
        makeCheckCall({
          id: 'cc-1',
          personContacted: 'QUO',
          contactMethod: 'QUO',
          locationCity: undefined,
          locationState: undefined,
          locationZip: undefined,
          eta: undefined,
          notes: undefined,
        }),
      ],
    });
    renderTab(load);

    fireEvent.click(screen.getAllByText('QUO')[0]);

    expect(screen.getByText('Check Call Details')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^null$/i)).not.toBeInTheDocument();
    // Location, ETA, and Notes are all genuinely absent — each renders the
    // app's existing empty-value convention.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('renders existing Check Call summary rows unchanged when there are none / when present (no regression)', () => {
    renderTab(makeLoad({ checkCalls: [] }));
    expect(screen.getByText('No check calls logged yet.')).toBeInTheDocument();
  });
});
