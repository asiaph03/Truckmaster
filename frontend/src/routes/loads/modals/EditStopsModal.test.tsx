import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { EditStopsModal } from './EditStopsModal';
import type { Load } from '../../../api';

const LOAD: Load = {
  id: 'load-1',
  loadNumber: 'LOAD-000001',
  customerId: 'customer-1',
  bookingSource: 'DIRECT',
  status: 'BOOKED',
  equipmentType: 'DRY_VAN',
  customerRate: '1800.00',
  rateSource: 'MANUAL',
  rateAgreementId: null,
  podStatus: 'NOT_RECEIVED',
  riskStatus: 'NORMAL',
  invoiced: false,
  createdByUserId: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stops: [
    {
      id: 'stop-1',
      loadId: 'load-1',
      sequence: 1,
      stopType: 'PICKUP',
      stopPurpose: 'STANDARD',
      companyName: 'Old Pickup Co',
      addressLine1: '1 Dock Rd',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
      status: 'PENDING',
    },
    {
      id: 'stop-2',
      loadId: 'load-1',
      sequence: 2,
      stopType: 'DELIVERY',
      stopPurpose: 'STANDARD',
      companyName: 'Old Delivery Co',
      addressLine1: '2 Dock Rd',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      status: 'PENDING',
    },
  ],
  sourcingAttempts: [],
  dispatchRecord: null,
  checkCalls: [],
  chargeLineItems: [],
};

describe('EditStopsModal — Load Detail Edit Stops action', () => {
  it('sends one PATCH with every stop, sequence-matched, on Save', async () => {
    const receivedBodies: unknown[] = [];
    server.use(
      http.patch('/api/v1/loads/load-1/stops', async ({ request }) => {
        receivedBodies.push(await request.json());
        return HttpResponse.json({ stops: LOAD.stops, load: LOAD }, { status: 200 });
      }),
    );

    let saved = false;
    render(
      <EditStopsModal
        open
        load={LOAD}
        onClose={() => {}}
        onSaved={() => {
          saved = true;
        }}
      />,
    );

    fireEvent.change(screen.getAllByLabelText(/^Company Name/)[0], {
      target: { value: 'ABC Manufacturing' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0]).toEqual({
      stops: [
        {
          sequence: 1,
          stopType: 'PICKUP',
          companyName: 'ABC Manufacturing',
          addressLine1: '1 Dock Rd',
          city: 'Dallas',
          state: 'TX',
          zip: '75201',
          appointmentDatetime: undefined,
          contactName: undefined,
          contactPhone: undefined,
          notes: undefined,
        },
        {
          sequence: 2,
          stopType: 'DELIVERY',
          companyName: 'Old Delivery Co',
          addressLine1: '2 Dock Rd',
          city: 'Chicago',
          state: 'IL',
          zip: '60601',
          appointmentDatetime: undefined,
          contactName: undefined,
          contactPhone: undefined,
          notes: undefined,
        },
      ],
    });
    expect(saved).toBe(true);
  });

  it('never renders an Add/Remove stop control — field edits only', () => {
    render(<EditStopsModal open load={LOAD} onClose={() => {}} onSaved={() => {}} />);

    expect(screen.queryByText('+ Add Pickup')).not.toBeInTheDocument();
    expect(screen.queryByText('+ Add Delivery')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove stop/)).not.toBeInTheDocument();
  });

  it('never calls onSaved when the batch is rejected — the whole edit fails together, not partially', async () => {
    let requestCount = 0;
    server.use(
      http.patch('/api/v1/loads/load-1/stops', () => {
        requestCount += 1;
        return HttpResponse.json(
          { error: { code: 'NOT_FOUND', message: 'Stop 2 not found.' } },
          { status: 404 },
        );
      }),
    );

    let saved = false;
    render(
      <EditStopsModal
        open
        load={LOAD}
        onClose={() => {}}
        onSaved={() => {
          saved = true;
        }}
      />,
    );

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(requestCount).toBe(1));
    expect(saved).toBe(false);
  });
});
