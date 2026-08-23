import type { StopFormValue } from './StopListEditor';

/** Mirrors the server-side "≥1 Pickup + ≥1 Delivery" rule (QuoteService/LoadService) client-side. */
export function validateStops(stops: StopFormValue[]): string | null {
  if (!stops.some((s) => s.stopType === 'PICKUP')) return 'At least one Pickup stop is required.';
  if (!stops.some((s) => s.stopType === 'DELIVERY'))
    return 'At least one Delivery stop is required.';
  return null;
}

export function sequenceStops(stops: StopFormValue[]): (StopFormValue & { sequence: number })[] {
  return stops.map((s, i) => ({ ...s, sequence: i + 1 }));
}
