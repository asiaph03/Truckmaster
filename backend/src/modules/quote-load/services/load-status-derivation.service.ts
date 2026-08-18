import { Injectable } from '@nestjs/common';
import { LoadStatus, StopStatus, StopType } from '@prisma/client';

export interface StopProgressInput {
  stopType: StopType;
  status: StopStatus;
  sequence: number;
}

const DERIVABLE_STATUSES: LoadStatus[] = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'];

/**
 * TECHNICAL_ARCHITECTURE.md §6.3 `deriveLoadStatus` — a faithful,
 * line-for-line port of the locked pseudocode (§14's "faithful reference
 * implementation" standard, the same one already applied to
 * `CarrierEligibilityService.recalculate`), including its literal reliance
 * on JS's vacuous-true `Array.prototype.every` for an empty pickups/
 * deliveries array — never realistically empty in practice (booking
 * requires ≥1 pickup + ≥1 delivery, enforced in LoadService/QuoteService),
 * so no defensive special-casing is added here that the pseudocode itself
 * doesn't have.
 *
 * Pure and stateless — kept as its own small service (mirroring the
 * RateAgreementMatchingService precedent) purely so it's independently
 * unit-testable against fixture inputs per §16's testing strategy, called
 * by DispatchTrackingService after every arrival/departure inside the same
 * transaction. Never called directly by a controller, and no endpoint ever
 * accepts Load.status as a directly-settable value for DISPATCHED→PICKUP→
 * IN_TRANSIT→DELIVERED — this function is the only path to those values.
 */
@Injectable()
export class LoadStatusDerivationService {
  deriveLoadStatus(currentStatus: LoadStatus, stops: StopProgressInput[]): LoadStatus {
    if (!DERIVABLE_STATUSES.includes(currentStatus)) return currentStatus;

    const pickups = stops.filter((s) => s.stopType === 'PICKUP');
    const deliveries = [...stops.filter((s) => s.stopType === 'DELIVERY')].sort(
      (a, b) => a.sequence - b.sequence,
    );
    const finalDelivery = deliveries[deliveries.length - 1];

    const allPickupsCompleted = pickups.every((s) => s.status === 'COMPLETED');

    if (finalDelivery && finalDelivery.status === 'COMPLETED' && allPickupsCompleted) {
      return 'DELIVERED';
    }
    if (allPickupsCompleted) return 'IN_TRANSIT';
    if (pickups.some((s) => s.status !== 'PENDING')) return 'PICKUP';
    return currentStatus;
  }
}
