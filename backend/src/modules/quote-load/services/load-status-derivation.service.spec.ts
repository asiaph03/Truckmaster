import { LoadStatus } from '@prisma/client';
import { LoadStatusDerivationService, StopProgressInput } from './load-status-derivation.service';

/** TECHNICAL_ARCHITECTURE.md §6.3 deriveLoadStatus — table-driven against the locked pseudocode. */
describe('LoadStatusDerivationService.deriveLoadStatus', () => {
  const service = new LoadStatusDerivationService();

  function stop(
    stopType: StopProgressInput['stopType'],
    status: StopProgressInput['status'],
    sequence: number,
    stopPurpose: StopProgressInput['stopPurpose'] = 'STANDARD',
  ): StopProgressInput {
    return { stopType, status, sequence, stopPurpose };
  }

  const cases: {
    name: string;
    currentStatus: LoadStatus;
    stops: StopProgressInput[];
    expected: LoadStatus;
  }[] = [
    {
      name: 'not-yet-dispatched statuses are never touched (not applicable)',
      currentStatus: 'CARRIER_ASSIGNED',
      stops: [stop('PICKUP', 'PENDING', 1), stop('DELIVERY', 'PENDING', 2)],
      expected: 'CARRIER_ASSIGNED',
    },
    {
      name: 'BOOKED is never touched (not applicable)',
      currentStatus: 'BOOKED',
      stops: [stop('PICKUP', 'COMPLETED', 1), stop('DELIVERY', 'COMPLETED', 2)],
      expected: 'BOOKED',
    },
    {
      name: 'DISPATCHED stays DISPATCHED while every stop is still PENDING',
      currentStatus: 'DISPATCHED',
      stops: [stop('PICKUP', 'PENDING', 1), stop('DELIVERY', 'PENDING', 2)],
      expected: 'DISPATCHED',
    },
    {
      name: 'DISPATCHED -> PICKUP once the first pickup arrives (single pickup)',
      currentStatus: 'DISPATCHED',
      stops: [stop('PICKUP', 'ARRIVED', 1), stop('DELIVERY', 'PENDING', 2)],
      expected: 'PICKUP',
    },
    {
      name: 'DISPATCHED -> PICKUP: multi-pickup, one completed but not all (still not IN_TRANSIT)',
      currentStatus: 'DISPATCHED',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('PICKUP', 'PENDING', 2),
        stop('DELIVERY', 'PENDING', 3),
      ],
      expected: 'PICKUP',
    },
    {
      name: 'PICKUP -> IN_TRANSIT once every pickup stop is COMPLETED',
      currentStatus: 'PICKUP',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('PICKUP', 'COMPLETED', 2),
        stop('DELIVERY', 'PENDING', 3),
      ],
      expected: 'IN_TRANSIT',
    },
    {
      name: 'multi-delivery: an earlier delivery completing does not advance to DELIVERED — only the FINAL (by sequence) delivery counts',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'COMPLETED', 2),
        stop('DELIVERY', 'PENDING', 3),
      ],
      expected: 'IN_TRANSIT',
    },
    {
      name: 'IN_TRANSIT -> DELIVERED once the final-by-sequence delivery stop is COMPLETED',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'COMPLETED', 2),
        stop('DELIVERY', 'COMPLETED', 3),
      ],
      expected: 'DELIVERED',
    },
    {
      name: 'final delivery is determined by sequence, not by array order',
      currentStatus: 'IN_TRANSIT',
      stops: [
        // Array order deliberately reversed vs. sequence order — the true
        // final stop (seq 3, COMPLETED) must still be found correctly.
        stop('DELIVERY', 'COMPLETED', 3),
        stop('DELIVERY', 'PENDING', 2),
        stop('PICKUP', 'COMPLETED', 1),
      ],
      expected: 'DELIVERED',
    },
    {
      name: 'final delivery (by sequence) still pending, even though an earlier-sequence delivery is complete, and the array lists it first',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('DELIVERY', 'PENDING', 3), // final by sequence — still pending
        stop('DELIVERY', 'COMPLETED', 2),
        stop('PICKUP', 'COMPLETED', 1),
      ],
      expected: 'IN_TRANSIT',
    },
    {
      name: 'DELIVERED is never re-derived (not in the applicable set) — no regression',
      currentStatus: 'DELIVERED',
      stops: [stop('PICKUP', 'PENDING', 1), stop('DELIVERY', 'PENDING', 2)],
      expected: 'DELIVERED',
    },
    {
      name: 'CLOSED is never re-derived (not in the applicable set)',
      currentStatus: 'CLOSED',
      stops: [stop('PICKUP', 'COMPLETED', 1), stop('DELIVERY', 'COMPLETED', 2)],
      expected: 'CLOSED',
    },
    // --- Return Product feature — Decision 1 (stopPurpose: STANDARD filter) ---
    {
      name: 'a completed return pickup+delivery, appended after an already-DELIVERED standard pair, does not change the outcome (DELIVERED)',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'COMPLETED', 2),
        stop('PICKUP', 'COMPLETED', 3, 'RETURN'),
        stop('DELIVERY', 'COMPLETED', 4, 'RETURN'),
      ],
      expected: 'DELIVERED',
    },
    {
      name: 'a return pickup+delivery pending does not block DELIVERED once the standard pair completes',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'COMPLETED', 2),
        stop('PICKUP', 'PENDING', 3, 'RETURN'),
        stop('DELIVERY', 'PENDING', 4, 'RETURN'),
      ],
      expected: 'DELIVERED',
    },
    {
      name: 'the corrected Risk 1 scenario: a COMPLETED return delivery must NOT drive DELIVERED while the standard delivery is still incomplete',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'ARRIVED', 2), // standard delivery NOT completed
        stop('PICKUP', 'COMPLETED', 3, 'RETURN'),
        stop('DELIVERY', 'COMPLETED', 4, 'RETURN'), // return delivery IS completed
      ],
      expected: 'IN_TRANSIT',
    },
    {
      name: 'a newly-appended, still-PENDING return pickup does not flip allPickupsCompleted to false for the standard pair',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'COMPLETED', 2),
        stop('PICKUP', 'PENDING', 3, 'RETURN'),
      ],
      expected: 'DELIVERED',
    },
    {
      name: 'multiple return pairs, all interleaved with the standard pair, never affect status',
      currentStatus: 'IN_TRANSIT',
      stops: [
        stop('PICKUP', 'PENDING', 5, 'RETURN'),
        stop('DELIVERY', 'COMPLETED', 4, 'RETURN'),
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'COMPLETED', 3),
        stop('PICKUP', 'COMPLETED', 2, 'RETURN'),
      ],
      expected: 'DELIVERED',
    },
  ];

  for (const { name, currentStatus, stops, expected } of cases) {
    it(name, () => {
      expect(service.deriveLoadStatus(currentStatus, stops)).toBe(expected);
    });
  }

  // DELIVERED is a terminal/sticky value (not in DERIVABLE_STATUSES) — this
  // is what actually prevents any literal regression, independent of the
  // stopPurpose filter; kept as its own explicit assertion since it's easy
  // to conflate with the (separate) Decision 1 protection above.
  it('DELIVERED never regresses even with an unfiltered mix of incomplete return stops', () => {
    expect(
      service.deriveLoadStatus('DELIVERED', [
        stop('PICKUP', 'COMPLETED', 1),
        stop('DELIVERY', 'COMPLETED', 2),
        stop('PICKUP', 'PENDING', 3, 'RETURN'),
        stop('DELIVERY', 'PENDING', 4, 'RETURN'),
      ]),
    ).toBe('DELIVERED');
  });
});
