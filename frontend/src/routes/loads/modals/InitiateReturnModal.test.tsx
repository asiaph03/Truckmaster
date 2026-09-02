import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { InitiateReturnModal } from './InitiateReturnModal';

function setField(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement;
  fireEvent.change(el, { target: { value } });
}

function fillReturnPickup() {
  setField('pickup-company-name', 'Return Test Customer');
  setField('pickup-address-line-1', '2 Dock Rd');
  setField('pickup-city', 'Chicago');
  setField('pickup-state', 'IL');
  setField('pickup-zip', '60601');
}

function fillReturnDelivery() {
  setField('delivery-company-name', 'St. Jude Candle Company');
  setField('delivery-address-line-1', '1 Dock Rd');
  setField('delivery-city', 'Dallas');
  setField('delivery-state', 'TX');
  setField('delivery-zip', '75201');
}

function clickInitiateReturn() {
  fireEvent.click(screen.getByRole('button', { name: 'Initiate Return' }));
}

describe('InitiateReturnModal — Return Product feature', () => {
  it('renders both a Return Pickup and a Return Delivery section', () => {
    render(<InitiateReturnModal open loadId="load-1" onClose={() => {}} onInitiated={() => {}} />);
    expect(screen.getByText('Return Pickup')).toBeInTheDocument();
    expect(screen.getByText('Return Delivery')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^Company Name/)).toHaveLength(2);
  });

  it('never submits when required fields are left empty', async () => {
    let requestCount = 0;
    server.use(
      http.post('/api/v1/loads/load-1/stops/return', () => {
        requestCount += 1;
        return HttpResponse.json({ stops: [], load: {} }, { status: 201 });
      }),
    );

    render(<InitiateReturnModal open loadId="load-1" onClose={() => {}} onInitiated={() => {}} />);
    clickInitiateReturn();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestCount).toBe(0);
  });

  it('submits the exact pickupStop/deliveryStop body and calls onInitiated on success', async () => {
    const receivedBodies: unknown[] = [];
    server.use(
      http.post('/api/v1/loads/load-1/stops/return', async ({ request }) => {
        receivedBodies.push(await request.json());
        return HttpResponse.json(
          {
            stops: [
              { id: 's3', sequence: 3, stopType: 'PICKUP', stopPurpose: 'RETURN' },
              { id: 's4', sequence: 4, stopType: 'DELIVERY', stopPurpose: 'RETURN' },
            ],
            load: { id: 'load-1', status: 'DELIVERED' },
          },
          { status: 201 },
        );
      }),
    );

    let initiated = false;
    render(
      <InitiateReturnModal
        open
        loadId="load-1"
        onClose={() => {}}
        onInitiated={() => {
          initiated = true;
        }}
      />,
    );

    fillReturnPickup();
    fillReturnDelivery();
    clickInitiateReturn();

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0]).toEqual({
      pickupStop: {
        companyName: 'Return Test Customer',
        addressLine1: '2 Dock Rd',
        city: 'Chicago',
        state: 'IL',
        zip: '60601',
        appointmentDatetime: undefined,
        contactName: '',
        contactPhone: '',
        notes: '',
      },
      deliveryStop: {
        companyName: 'St. Jude Candle Company',
        addressLine1: '1 Dock Rd',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        appointmentDatetime: undefined,
        contactName: '',
        contactPhone: '',
        notes: '',
      },
    });
    await waitFor(() => expect(initiated).toBe(true));
  });

  describe('appointmentDatetime — blank must not become an invalid empty-string date', () => {
    // Regression test: the backend's `@IsOptional() @IsDateString()` only
    // skips validation for undefined/null, not '' — an untouched
    // datetime-local input submits '', which the backend previously
    // rejected as "not a valid ISO 8601 date string", blocking Initiate
    // Return whenever the (optional) Appointment field was left blank.
    // Caught by a real production smoke test.

    async function submitAndGetBody(
      appointments: { pickup?: string; delivery?: string } = {},
    ): Promise<Record<string, unknown>> {
      let receivedBody: Record<string, unknown> | undefined;
      server.use(
        http.post('/api/v1/loads/load-1/stops/return', async ({ request }) => {
          receivedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              stops: [
                { id: 's3', sequence: 3, stopType: 'PICKUP', stopPurpose: 'RETURN' },
                { id: 's4', sequence: 4, stopType: 'DELIVERY', stopPurpose: 'RETURN' },
              ],
              load: { id: 'load-1', status: 'DELIVERED' },
            },
            { status: 201 },
          );
        }),
      );

      render(
        <InitiateReturnModal open loadId="load-1" onClose={() => {}} onInitiated={() => {}} />,
      );
      fillReturnPickup();
      fillReturnDelivery();
      if (appointments.pickup) setField('pickup-appointment', appointments.pickup);
      if (appointments.delivery) setField('delivery-appointment', appointments.delivery);
      clickInitiateReturn();

      await waitFor(() => expect(receivedBody).toBeDefined());
      return receivedBody!;
    }

    it('both appointment fields left blank — request omits/undefined them, and the call still succeeds', async () => {
      const body = await submitAndGetBody();
      const pickup = body.pickupStop as Record<string, unknown>;
      const delivery = body.deliveryStop as Record<string, unknown>;
      expect(pickup.appointmentDatetime).toBeUndefined();
      expect(delivery.appointmentDatetime).toBeUndefined();
    });

    it('pickup appointment populated — the entered value is preserved, delivery stays undefined', async () => {
      const body = await submitAndGetBody({ pickup: '2026-09-15T14:30' });
      const pickup = body.pickupStop as Record<string, unknown>;
      const delivery = body.deliveryStop as Record<string, unknown>;
      expect(pickup.appointmentDatetime).toBe('2026-09-15T14:30');
      expect(delivery.appointmentDatetime).toBeUndefined();
    });

    it('delivery appointment populated — the entered value is preserved, pickup stays undefined', async () => {
      const body = await submitAndGetBody({ delivery: '2026-09-16T09:00' });
      const pickup = body.pickupStop as Record<string, unknown>;
      const delivery = body.deliveryStop as Record<string, unknown>;
      expect(pickup.appointmentDatetime).toBeUndefined();
      expect(delivery.appointmentDatetime).toBe('2026-09-16T09:00');
    });

    it('both appointments populated — both entered values are preserved', async () => {
      const body = await submitAndGetBody({
        pickup: '2026-09-15T14:30',
        delivery: '2026-09-16T09:00',
      });
      const pickup = body.pickupStop as Record<string, unknown>;
      const delivery = body.deliveryStop as Record<string, unknown>;
      expect(pickup.appointmentDatetime).toBe('2026-09-15T14:30');
      expect(delivery.appointmentDatetime).toBe('2026-09-16T09:00');
    });
  });
});
