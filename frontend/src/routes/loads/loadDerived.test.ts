import { describe, expect, it } from 'vitest';
import { originDestination, firstPickupDate, lastDeliveryDate } from './loadDerived';
import type { Stop } from '../../api';

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

describe('loadDerived — Return Product feature: RETURN stops never affect the reported lane/dates', () => {
  const standardPickup = makeStop({
    sequence: 1,
    stopType: 'PICKUP',
    stopPurpose: 'STANDARD',
    city: 'Dallas',
    state: 'TX',
    appointmentDatetime: '2026-01-01T08:00:00.000Z',
  });
  const standardDelivery = makeStop({
    sequence: 2,
    stopType: 'DELIVERY',
    stopPurpose: 'STANDARD',
    city: 'Chicago',
    state: 'IL',
    appointmentDatetime: '2026-01-02T08:00:00.000Z',
  });
  const returnPickup = makeStop({
    sequence: 3,
    stopType: 'PICKUP',
    stopPurpose: 'RETURN',
    city: 'Chicago',
    state: 'IL',
    appointmentDatetime: '2026-01-05T08:00:00.000Z',
  });
  const returnDelivery = makeStop({
    sequence: 4,
    stopType: 'DELIVERY',
    stopPurpose: 'RETURN',
    city: 'Dallas',
    state: 'TX',
    appointmentDatetime: '2026-01-06T08:00:00.000Z',
  });

  it('originDestination reports the standard pickup/delivery lane, ignoring an appended return pair', () => {
    expect(
      originDestination([standardPickup, standardDelivery, returnPickup, returnDelivery]),
    ).toBe('Dallas, TX → Chicago, IL');
  });

  it('firstPickupDate uses the standard pickup, not the later return pickup', () => {
    expect(firstPickupDate([standardPickup, standardDelivery, returnPickup, returnDelivery])).toBe(
      '2026-01-01T08:00:00.000Z',
    );
  });

  it('lastDeliveryDate uses the standard delivery, not the later return delivery', () => {
    expect(lastDeliveryDate([standardPickup, standardDelivery, returnPickup, returnDelivery])).toBe(
      '2026-01-02T08:00:00.000Z',
    );
  });

  it('interleaved order does not matter — filtering is by stopPurpose, not position', () => {
    const stops = [returnPickup, standardPickup, returnDelivery, standardDelivery];
    expect(originDestination(stops)).toBe('Dallas, TX → Chicago, IL');
    expect(firstPickupDate(stops)).toBe('2026-01-01T08:00:00.000Z');
    expect(lastDeliveryDate(stops)).toBe('2026-01-02T08:00:00.000Z');
  });

  it('a Load with only return stops (no standard stops) has no reportable lane/dates', () => {
    expect(originDestination([returnPickup, returnDelivery])).toBe('—');
    expect(firstPickupDate([returnPickup, returnDelivery])).toBeNull();
    expect(lastDeliveryDate([returnPickup, returnDelivery])).toBeNull();
  });
});
