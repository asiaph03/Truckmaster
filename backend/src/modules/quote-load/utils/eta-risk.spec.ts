import { evaluateEtaRisk, computeEtaRiskSeverity, findApplicableAppointmentStop } from './eta-risk';
import type { LatenessStopInput } from './load-lateness';

const APPOINTMENT = new Date('2026-09-05T19:00:00.000Z'); // 2:00 PM ET-equivalent, arbitrary

function stop(overrides: Partial<LatenessStopInput> = {}): LatenessStopInput {
  return {
    stopType: 'PICKUP',
    status: 'PENDING',
    appointmentDatetime: APPOINTMENT,
    sequence: 1,
    stopPurpose: 'STANDARD',
    ...overrides,
  };
}

describe('evaluateEtaRisk — ETA_AFTER_APPOINTMENT detector logic', () => {
  it('returns null when there is no applicable appointment at all', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T20:00:00.000Z'),
      stops: [stop({ appointmentDatetime: null })],
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no current ETA — never invents one', () => {
    const result = evaluateEtaRisk({ currentEta: null, stops: [stop()] });
    expect(result).toBeNull();
  });

  it('returns null when the ETA is before the appointment (on time)', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T18:30:00.000Z'), // 30min before appointment
      stops: [stop()],
    });
    expect(result).toBeNull();
  });

  it('returns null when the ETA exactly equals the appointment (not strictly after)', () => {
    const result = evaluateEtaRisk({ currentEta: APPOINTMENT, stops: [stop()] });
    expect(result).toBeNull();
  });

  it('MEDIUM: ETA less than 15 minutes after the appointment', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T19:10:00.000Z'), // +10min
      stops: [stop()],
    });
    expect(result).toEqual(
      expect.objectContaining({ minutesAfter: 10, severity: 'MEDIUM', stopType: 'PICKUP' }),
    );
  });

  it('HIGH: ETA 15–59 minutes after the appointment (lower boundary)', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T19:15:00.000Z'), // +15min exactly
      stops: [stop()],
    });
    expect(result).toEqual(expect.objectContaining({ minutesAfter: 15, severity: 'HIGH' }));
  });

  it('HIGH: ETA 59 minutes after the appointment (upper boundary)', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T19:59:00.000Z'), // +59min
      stops: [stop()],
    });
    expect(result).toEqual(expect.objectContaining({ minutesAfter: 59, severity: 'HIGH' }));
  });

  it('CRITICAL: ETA 60+ minutes after the appointment (lower boundary)', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T20:00:00.000Z'), // +60min exactly
      stops: [stop()],
    });
    expect(result).toEqual(expect.objectContaining({ minutesAfter: 60, severity: 'CRITICAL' }));
  });

  it('CRITICAL: ETA 78 minutes after the appointment', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T20:18:00.000Z'), // +78min
      stops: [stop()],
    });
    expect(result).toEqual(expect.objectContaining({ minutesAfter: 78, severity: 'CRITICAL' }));
  });

  it('never geocodes or infers — the appointment/ETA are used exactly as stored', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T20:00:00.000Z'),
      stops: [stop()],
    });
    expect(result?.appointmentDatetime).toBe(APPOINTMENT);
  });

  it('a COMPLETED stop is never the applicable appointment, even with an at-risk ETA', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T20:00:00.000Z'),
      stops: [stop({ status: 'COMPLETED' })],
    });
    expect(result).toBeNull();
  });

  it('a RETURN-purpose stop is never the applicable appointment', () => {
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-05T20:00:00.000Z'),
      stops: [stop({ stopPurpose: 'RETURN' })],
    });
    expect(result).toBeNull();
  });

  it('a future appointment can still be "at risk" — unlike findLateStop, this is predictive, not "already passed"', () => {
    const futureAppointment = new Date('2099-01-01T12:00:00.000Z');
    const now = new Date('2099-01-01T11:00:00.000Z'); // appointment is still upcoming relative to "now"
    const result = evaluateEtaRisk({
      currentEta: new Date('2099-01-01T13:00:00.000Z'),
      stops: [stop({ appointmentDatetime: futureAppointment })],
      now,
    });
    expect(result).toEqual(expect.objectContaining({ minutesAfter: 60, severity: 'CRITICAL' }));
  });

  it('B.2 correctness review — a stale, forgotten early stop never anchors the comparison once a later stop is operationally current', () => {
    // Exact scenario from the review: Stop 1's pickup appointment was
    // yesterday and it is still (incorrectly, or simply not-yet-logged)
    // PENDING; Stop 2's delivery appointment is today. The Load's real
    // currentEta is for today's delivery. Anchoring to Stop 1 (old
    // "earliest sequence wins" behavior) would have produced a bogus
    // ~24h-late CRITICAL alert; the correct behavior compares against
    // Stop 2, whose appointment is actually close to `now`.
    const now = new Date('2026-09-06T18:00:00.000Z'); // "today", 2:00 PM ET-equivalent
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-06T19:18:00.000Z'), // 78min after today's delivery appointment
      stops: [
        stop({
          stopType: 'PICKUP',
          sequence: 1,
          status: 'PENDING',
          appointmentDatetime: new Date('2026-09-05T19:00:00.000Z'), // yesterday — stale
        }),
        stop({
          stopType: 'DELIVERY',
          sequence: 2,
          status: 'PENDING',
          appointmentDatetime: new Date('2026-09-06T18:00:00.000Z'), // today — operationally current
        }),
      ],
      now,
    });
    expect(result).toEqual(
      expect.objectContaining({ stopType: 'DELIVERY', minutesAfter: 78, severity: 'CRITICAL' }),
    );
  });

  it('an ARRIVED stop is never the applicable appointment — its own risk is already resolved either way', () => {
    // Same shape as the stale-stop scenario, but Stop 1 is explicitly
    // ARRIVED (not just PENDING-and-forgotten) — must still defer to
    // Stop 2, and must not treat the ARRIVED stop as a fallback candidate
    // even though it technically is not COMPLETED.
    const now = new Date('2026-09-06T18:00:00.000Z');
    const result = evaluateEtaRisk({
      currentEta: new Date('2026-09-06T18:30:00.000Z'),
      stops: [
        stop({
          stopType: 'PICKUP',
          sequence: 1,
          status: 'ARRIVED',
          appointmentDatetime: new Date('2026-09-05T19:00:00.000Z'),
        }),
        stop({
          stopType: 'DELIVERY',
          sequence: 2,
          status: 'PENDING',
          appointmentDatetime: new Date('2026-09-06T18:00:00.000Z'),
        }),
      ],
      now,
    });
    expect(result).toEqual(expect.objectContaining({ stopType: 'DELIVERY', minutesAfter: 30 }));
  });

  it('when two appointments are exactly equidistant from now, ties break deterministically by sequence', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const result = findApplicableAppointmentStop(
      [
        stop({
          stopType: 'DELIVERY',
          sequence: 2,
          appointmentDatetime: new Date('2026-09-07T00:00:00.000Z'),
        }), // +24h
        stop({
          stopType: 'PICKUP',
          sequence: 1,
          appointmentDatetime: new Date('2026-09-05T00:00:00.000Z'),
        }), // -24h
      ],
      now,
    );
    expect(result).toEqual(
      expect.objectContaining({ stopType: 'PICKUP' }), // lower sequence wins the tie
    );
  });
});

describe('findApplicableAppointmentStop', () => {
  it('returns null for a Load with no stops', () => {
    expect(findApplicableAppointmentStop([])).toBeNull();
  });

  it('treats a missing stopPurpose as STANDARD', () => {
    const withoutPurpose: Omit<LatenessStopInput, 'stopPurpose'> = {
      stopType: 'PICKUP',
      status: 'PENDING',
      appointmentDatetime: APPOINTMENT,
      sequence: 1,
    };
    expect(findApplicableAppointmentStop([withoutPurpose as LatenessStopInput])).not.toBeNull();
  });
});

describe('computeEtaRiskSeverity', () => {
  it.each([
    [1, 'MEDIUM'],
    [14, 'MEDIUM'],
    [15, 'HIGH'],
    [59, 'HIGH'],
    [60, 'CRITICAL'],
    [200, 'CRITICAL'],
  ])('%i minutes after → %s', (minutes, severity) => {
    expect(computeEtaRiskSeverity(minutes)).toBe(severity);
  });
});
