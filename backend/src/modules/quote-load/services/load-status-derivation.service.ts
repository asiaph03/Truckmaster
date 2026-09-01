import { Injectable } from '@nestjs/common';
import { LoadStatus, StopPurpose, StopStatus, StopType } from '@prisma/client';

export interface StopProgressInput {
  stopType: StopType;
  stopPurpose: StopPurpose;
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
 *
 * Return Product feature — both `pickups` and `deliveries` below are
 * filtered to `stopPurpose: STANDARD` only. `DELIVERED` is not itself in
 * `DERIVABLE_STATUSES` (a Load that already reached DELIVERED short-
 * circuits above and can never regress), so the real risk this filter
 * prevents is narrower than a regression: without it, a return delivery
 * appended *before* the standard delivery has completed could become the
 * "final delivery" that drives `DELIVERED`, letting the return leg's
 * completion stand in for the standard delivery's. Filtering both arrays
 * (not just `deliveries`) keeps a newly-appended return pickup from
 * flipping `allPickupsCompleted` to false too.
 *
 * `s.stopPurpose === 'STANDARD'` is deliberately written as
 * `(s.stopPurpose ?? 'STANDARD') === 'STANDARD'` — an input missing the
 * field entirely (never true for a real DB row, which always has the
 * schema's default, but exactly the kind of partial object a caller
 * could accidentally pass) must not silently empty out `pickups`/
 * `deliveries` and trip the exact vacuous-true `Array.prototype.every`
 * trap this class's own doc comment above already warns about.
 */
@Injectable()
export class LoadStatusDerivationService {
  deriveLoadStatus(currentStatus: LoadStatus, stops: StopProgressInput[]): LoadStatus {
    if (!DERIVABLE_STATUSES.includes(currentStatus)) return currentStatus;

    const isStandard = (s: StopProgressInput) => (s.stopPurpose ?? 'STANDARD') === 'STANDARD';
    const pickups = stops.filter((s) => s.stopType === 'PICKUP' && isStandard(s));
    const deliveries = [...stops.filter((s) => s.stopType === 'DELIVERY' && isStandard(s))].sort(
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
