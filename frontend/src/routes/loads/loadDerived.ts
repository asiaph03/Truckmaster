import type { Load, Stop } from '../../api';

/**
 * A stop only carries its own company name when booked from a saved
 * CustomerLocation; a manually-entered/lane-level stop (customerLocationId
 * null -- Quote-converted loads, DATABASE_DESIGN.md §9) falls back to the
 * load's own customer, since every load always has exactly one.
 */
export function stopCompanyName(stop: Stop, load: Load): string {
  return stop.customerLocation?.customer.legalName ?? load.customer.legalName;
}

/** First Pickup / last Delivery by sequence — matches the locked Table View column derivation (§5.4.1). */
export function originDestination(stops: Stop[]): string {
  const pickups = stops
    .filter((s) => s.stopType === 'PICKUP')
    .sort((a, b) => a.sequence - b.sequence);
  const deliveries = stops
    .filter((s) => s.stopType === 'DELIVERY')
    .sort((a, b) => a.sequence - b.sequence);
  const origin = pickups[0];
  const destination = deliveries[deliveries.length - 1];
  if (!origin || !destination) return '—';
  return `${origin.city}, ${origin.state} → ${destination.city}, ${destination.state}`;
}

export function firstPickupDate(stops: Stop[]): string | null {
  const pickups = stops
    .filter((s) => s.stopType === 'PICKUP')
    .sort((a, b) => a.sequence - b.sequence);
  return pickups[0]?.appointmentDatetime ?? null;
}

export function lastDeliveryDate(stops: Stop[]): string | null {
  const deliveries = stops
    .filter((s) => s.stopType === 'DELIVERY')
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
