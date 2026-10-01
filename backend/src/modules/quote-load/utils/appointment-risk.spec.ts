import { evaluateAppointmentImminent } from './appointment-risk';
import type { LatenessStopInput } from './load-lateness';

const NOW = new Date('2026-09-05T19:00:00.000Z');

function minutesFromNow(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60000);
}

function stop(overrides: Partial<LatenessStopInput> = {}): LatenessStopInput {
  return {
    stopType: 'PICKUP',
    status: 'PENDING',
    appointmentDatetime: minutesFromNow(90),
    sequence: 1,
    stopPurpose: 'STANDARD',
    ...overrides,
  };
}

describe('evaluateAppointmentImminent — APPOINTMENT_IMMINENT_NO_CHECK_CALL detector logic', () => {
  it('1. no alert when the appointment is more than 180 minutes away', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(181) })],
      currentLocationUpdatedAt: minutesFromNow(-150),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('2. appointment exactly at the 180-minute threshold is included', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(180) })],
      currentLocationUpdatedAt: minutesFromNow(-120),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toEqual(
      expect.objectContaining({ minutesUntilAppointment: 180, severity: 'MEDIUM' }),
    );
  });

  it('3. no alert when the appointment qualifies but last activity is under 120 minutes old', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(90) })],
      currentLocationUpdatedAt: minutesFromNow(-119),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('4. MEDIUM when appointment <=180min and activity >=120min stale (not within the HIGH window)', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(90) })],
      currentLocationUpdatedAt: minutesFromNow(-120),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toEqual(
      expect.objectContaining({
        severity: 'MEDIUM',
        minutesUntilAppointment: 90,
        minutesSinceLastActivity: 120,
      }),
    );
  });

  it('5. HIGH when appointment <=60min and activity >=120min stale', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(60) })],
      currentLocationUpdatedAt: minutesFromNow(-120),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toEqual(
      expect.objectContaining({ severity: 'HIGH', minutesUntilAppointment: 60 }),
    );
  });

  it('6. falls back to DispatchRecord.dispatchedAt when no Check Call has ever been logged', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(90) })],
      currentLocationUpdatedAt: null,
      dispatchedAt: minutesFromNow(-180),
      now: NOW,
    });
    expect(result).toEqual(
      expect.objectContaining({
        lastActivitySource: 'DISPATCH',
        minutesSinceLastActivity: 180,
        severity: 'MEDIUM',
      }),
    );
  });

  it('7. a recent dispatch with no Check Call does not alert (dispatch 10 minutes ago, appointment in 90 minutes)', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(90) })],
      currentLocationUpdatedAt: null,
      dispatchedAt: minutesFromNow(-10),
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('7b. a dispatch 3 hours ago with no Check Call DOES alert (appointment in 90 minutes)', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(90) })],
      currentLocationUpdatedAt: null,
      dispatchedAt: minutesFromNow(-180),
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.lastActivitySource).toBe('DISPATCH');
  });

  it('8. a past appointment never alerts, even though findApplicableAppointmentStop can select it (real LOAD-000118 case)', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(-425) })],
      currentLocationUpdatedAt: minutesFromNow(-133),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('9. no alert when there is no applicable appointment at all', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: null })],
      currentLocationUpdatedAt: minutesFromNow(-200),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('10. a RETURN-purpose stop is excluded, even with a qualifying appointment', () => {
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(30), stopPurpose: 'RETURN' })],
      currentLocationUpdatedAt: minutesFromNow(-200),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('11. a non-PENDING (ARRIVED/COMPLETED) stop is excluded', () => {
    const arrived = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(30), status: 'ARRIVED' })],
      currentLocationUpdatedAt: minutesFromNow(-200),
      dispatchedAt: null,
      now: NOW,
    });
    const completed = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(30), status: 'COMPLETED' })],
      currentLocationUpdatedAt: minutesFromNow(-200),
      dispatchedAt: null,
      now: NOW,
    });
    expect(arrived).toBeNull();
    expect(completed).toBeNull();
  });

  it('12. a missing ETA does not prevent the alert (B.6 never reads currentEta at all)', () => {
    // evaluateAppointmentImminent's input type has no currentEta field — this
    // test documents that omission is deliberate, mirroring B.3's own
    // independence from Load.currentEta.
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(30) })],
      currentLocationUpdatedAt: minutesFromNow(-200),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).not.toBeNull();
  });

  it('13/14. an on-time or after-appointment ETA has no bearing on B.6 — the function never evaluates ETA at all', () => {
    // B.6's qualification rule is structurally incapable of being
    // suppressed by ETA, since EtaRiskInput's ETA field was never carried
    // into AppointmentImminentInput in the first place.
    const result = evaluateAppointmentImminent({
      stops: [stop({ appointmentDatetime: minutesFromNow(30) })],
      currentLocationUpdatedAt: minutesFromNow(-200),
      dispatchedAt: null,
      now: NOW,
    });
    expect(result).toEqual(expect.objectContaining({ severity: 'HIGH' }));
  });
});
