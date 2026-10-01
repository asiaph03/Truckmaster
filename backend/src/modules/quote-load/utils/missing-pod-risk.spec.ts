import { evaluateMissingPod } from './missing-pod-risk';

const NOW = new Date('2026-10-01T12:00:00.000Z');

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3600000);
}

describe('evaluateMissingPod — MISSING_POD detector logic (B.8, 48h business-policy threshold)', () => {
  it('1. DELIVERED under 48h — no alert', () => {
    const result = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(47),
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('2. DELIVERED exactly at 48h — HIGH (inclusive boundary)', () => {
    const result = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(48),
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toEqual(
      expect.objectContaining({
        severity: 'HIGH',
        clockBasis: 'deliveredAuditEntry',
        ageHours: 48,
      }),
    );
  });

  it('3. DELIVERED over 48h — HIGH', () => {
    const result = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(281),
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toEqual(expect.objectContaining({ severity: 'HIGH', ageHours: 281 }));
  });

  it('4. CLOSED under 48h — no alert', () => {
    const result = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: hoursAgo(10),
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('5. CLOSED exactly at 48h — HIGH', () => {
    const result = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: hoursAgo(48),
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toEqual(
      expect.objectContaining({ severity: 'HIGH', clockBasis: 'closedAt', ageHours: 48 }),
    );
  });

  it('6. CLOSED over 48h — HIGH', () => {
    const result = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: hoursAgo(635),
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toEqual(expect.objectContaining({ severity: 'HIGH', ageHours: 635 }));
  });

  it('7. zero POD documents — eligible (given a qualifying clock/age)', () => {
    const result = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(100),
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).not.toBeNull();
  });

  it('8. a POD document exists with CLEAN scan status — no alert', () => {
    // hasAnyPodDocument is true regardless of scanStatus — this function
    // never inspects scanStatus at all, by design (see doc comment).
    const result = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(100),
      hasAnyPodDocument: true,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('9. a POD document exists with SCAN_FAILED — no alert (intentional Cloudmersive free-tier override, not a defect)', () => {
    const result = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(281),
      hasAnyPodDocument: true,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('10. a POD document exists in any other state — no alert', () => {
    // hasAnyPodDocument being true is the only signal this function reads;
    // it is structurally incapable of distinguishing PENDING/INFECTED/
    // SCAN_FAILED/CLEAN from each other, by design.
    const result = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: hoursAgo(635),
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: true,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('11. a DELIVERED load with no resolvable delivered-transition AuditLog entry — no alert, never guesses', () => {
    const result = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('12. a CLOSED load with no closedAt — no alert, never falls back to another timestamp', () => {
    const result = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(1000), // present but irrelevant — CLOSED must use closedAt only
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('13. a non-DELIVERED/CLOSED status never alerts, even with a qualifying age', () => {
    for (const status of [
      'BOOKED',
      'CARRIER_SOURCING',
      'CARRIER_ASSIGNED',
      'RATE_CONFIRMATION',
      'DISPATCHED',
      'PICKUP',
      'IN_TRANSIT',
      'CANCELLED',
    ]) {
      const result = evaluateMissingPod({
        status,
        closedAt: hoursAgo(1000),
        deliveredAuditEntryAt: hoursAgo(1000),
        hasAnyPodDocument: false,
        now: NOW,
      });
      expect(result).toBeNull();
    }
  });

  it('14. exact boundary behavior — 47.9h does not qualify, 48.0h does', () => {
    const justUnder = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: new Date(NOW.getTime() - 47.9 * 3600000),
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: false,
      now: NOW,
    });
    const exactly = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: new Date(NOW.getTime() - 48 * 3600000),
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(justUnder).toBeNull();
    expect(exactly).not.toBeNull();
  });

  it('15. metadata clockBasis is correct for both DELIVERED and CLOSED', () => {
    const delivered = evaluateMissingPod({
      status: 'DELIVERED',
      closedAt: null,
      deliveredAuditEntryAt: hoursAgo(100),
      hasAnyPodDocument: false,
      now: NOW,
    });
    const closed = evaluateMissingPod({
      status: 'CLOSED',
      closedAt: hoursAgo(100),
      deliveredAuditEntryAt: null,
      hasAnyPodDocument: false,
      now: NOW,
    });
    expect(delivered?.clockBasis).toBe('deliveredAuditEntry');
    expect(closed?.clockBasis).toBe('closedAt');
  });
});
