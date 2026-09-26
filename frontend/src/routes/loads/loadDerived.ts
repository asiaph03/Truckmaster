import type { Stop } from '../../api';

/**
 * The minimal shape `originDestination` actually needs — satisfied by the
 * full `Stop` (OverviewTab, using every field) and by the lighter
 * per-load stop summary the fleet-map endpoint returns (FleetMap, which
 * never fetches full Stop rows just to derive a lane string).
 */
export type StopLaneFields = Pick<Stop, 'sequence' | 'stopType' | 'stopPurpose' | 'city' | 'state'>;

/**
 * First Pickup / last Delivery by sequence — matches the locked Table
 * View column derivation (§5.4.1). Return Product feature — filtered to
 * `stopPurpose: 'STANDARD'` (mirrors the exact same filter in the
 * backend's `load-search.service.ts` `pickStopDate`), so a return leg's
 * pickup/delivery never becomes the reported lane/date.
 */
export function originDestination(stops: StopLaneFields[]): string {
  const pickups = stops
    .filter((s) => s.stopType === 'PICKUP' && s.stopPurpose === 'STANDARD')
    .sort((a, b) => a.sequence - b.sequence);
  const deliveries = stops
    .filter((s) => s.stopType === 'DELIVERY' && s.stopPurpose === 'STANDARD')
    .sort((a, b) => a.sequence - b.sequence);
  const origin = pickups[0];
  const destination = deliveries[deliveries.length - 1];
  if (!origin || !destination) return '—';
  return `${origin.city}, ${origin.state} → ${destination.city}, ${destination.state}`;
}

/** The final Delivery stop's raw city/state (for geocoding) — same STANDARD-only filter as `originDestination`. */
export function destinationCityState(
  stops: StopLaneFields[],
): { city: string; state: string } | null {
  const deliveries = stops
    .filter((s) => s.stopType === 'DELIVERY' && s.stopPurpose === 'STANDARD')
    .sort((a, b) => a.sequence - b.sequence);
  const destination = deliveries[deliveries.length - 1];
  return destination ? { city: destination.city, state: destination.state } : null;
}

export function firstPickupDate(stops: Stop[]): string | null {
  const pickups = stops
    .filter((s) => s.stopType === 'PICKUP' && s.stopPurpose === 'STANDARD')
    .sort((a, b) => a.sequence - b.sequence);
  return pickups[0]?.appointmentDatetime ?? null;
}

export function lastDeliveryDate(stops: Stop[]): string | null {
  const deliveries = stops
    .filter((s) => s.stopType === 'DELIVERY' && s.stopPurpose === 'STANDARD')
    .sort((a, b) => a.sequence - b.sequence);
  return deliveries[deliveries.length - 1]?.appointmentDatetime ?? null;
}

/** Warning-colored per §5.4.1 when a pickup/delivery is within 4h and the stop hasn't Arrived yet. */
export function isWithinHours(dateStr: string | null, hours: number): boolean {
  if (!dateStr) return false;
  const diffMs = new Date(dateStr).getTime() - Date.now();
  return diffMs >= 0 && diffMs <= hours * 60 * 60 * 1000;
}

export function formatDateShort(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
