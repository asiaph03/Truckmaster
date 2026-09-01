import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StopsTrackingTab } from './StopsTrackingTab';
import { useSessionStore } from '../../../auth/session-store';
import type { Load, Stop } from '../../../api';

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
    render(<StopsTrackingTab load={load} onChanged={() => {}} />);

    expect(screen.getAllByText('Return')).toHaveLength(2);
  });

  it('hides the "+ Initiate Return" action entirely for a role without sourceAndDispatchLoads', () => {
    setRoles(['SALES_BOOKING']);
    const load = makeLoad({ status: 'DELIVERED' });
    render(<StopsTrackingTab load={load} onChanged={() => {}} />);

    expect(screen.queryByText('+ Initiate Return')).not.toBeInTheDocument();
  });

  it('disables "+ Initiate Return" with a tooltip on a pre-Dispatch (BOOKED) Load', () => {
    const load = makeLoad({ status: 'BOOKED' });
    render(<StopsTrackingTab load={load} onChanged={() => {}} />);

    const button = screen.getByText('+ Initiate Return').closest('button') as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button.title).toMatch(/Dispatched/);
  });

  it('enables "+ Initiate Return" on a DELIVERED Load and opens the modal on click', () => {
    const load = makeLoad({ status: 'DELIVERED' });
    render(<StopsTrackingTab load={load} onChanged={() => {}} />);

    const button = screen.getByText('+ Initiate Return').closest('button') as HTMLButtonElement;
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(screen.getByText('Return Pickup')).toBeInTheDocument();
    expect(screen.getByText('Return Delivery')).toBeInTheDocument();
  });

  it('enables "+ Initiate Return" on an IN_TRANSIT Load (still Dispatched, not yet Delivered)', () => {
    const load = makeLoad({ status: 'IN_TRANSIT' });
    render(<StopsTrackingTab load={load} onChanged={() => {}} />);

    const button = screen.getByText('+ Initiate Return').closest('button') as HTMLButtonElement;
    expect(button).not.toBeDisabled();
  });
});
