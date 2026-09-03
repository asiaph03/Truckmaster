import { findLateStop, type LatenessStopInput } from './load-lateness';

const NOW = new Date('2026-09-05T20:00:00.000Z');

function stop(overrides: Partial<LatenessStopInput> = {}): LatenessStopInput {
  return {
    stopType: 'PICKUP',
    status: 'PENDING',
    appointmentDatetime: new Date('2026-09-05T19:00:00.000Z'), // 1h before NOW
    sequence: 1,
    stopPurpose: 'STANDARD',
    ...overrides,
  };
}

describe('findLateStop — the one backend-owned "Load Late" definition', () => {
  it('returns the stop when it is PENDING with a past appointment', () => {
    const result = findLateStop([stop()], NOW);
    expect(result).toEqual({
      stopType: 'PICKUP',
      appointmentDatetime: new Date('2026-09-05T19:00:00.000Z'),
    });
  });

  it('returns the stop when it is ARRIVED (not yet COMPLETED) with a past appointment', () => {
    const result = findLateStop([stop({ status: 'ARRIVED' })], NOW);
    expect(result).not.toBeNull();
  });

  it('returns null for a COMPLETED stop with a past appointment — never treats a completed stop as late', () => {
    const result = findLateStop([stop({ status: 'COMPLETED' })], NOW);
    expect(result).toBeNull();
  });

  it('returns null when the appointment is still in the future', () => {
    const result = findLateStop(
      [stop({ appointmentDatetime: new Date('2026-09-05T21:00:00.000Z') })], // 1h after NOW
      NOW,
    );
    expect(result).toBeNull();
  });

  it('returns null when appointmentDatetime is null', () => {
    const result = findLateStop([stop({ appointmentDatetime: null })], NOW);
    expect(result).toBeNull();
  });

  it('returns null for a Load with no stops', () => {
    expect(findLateStop([], NOW)).toBeNull();
  });

  it('with multiple late stops, returns the earliest by sequence, not by appointment time', () => {
    const result = findLateStop(
      [
        stop({
          stopType: 'DELIVERY',
          sequence: 2,
          appointmentDatetime: new Date('2026-09-05T18:00:00.000Z'), // earlier appt, later sequence
        }),
        stop({
          stopType: 'PICKUP',
          sequence: 1,
          appointmentDatetime: new Date('2026-09-05T19:30:00.000Z'), // later appt, earlier sequence
        }),
      ],
      NOW,
    );
    expect(result).toEqual({
      stopType: 'PICKUP',
      appointmentDatetime: new Date('2026-09-05T19:30:00.000Z'),
    });
  });

  it('ignores a future, not-yet-late stop when an earlier stop is already late — only the late one is returned', () => {
    const result = findLateStop(
      [
        stop({ sequence: 1, status: 'COMPLETED' }),
        stop({
          stopType: 'DELIVERY',
          sequence: 2,
          appointmentDatetime: new Date('2026-09-05T21:00:00.000Z'), // future
        }),
      ],
      NOW,
    );
    expect(result).toBeNull();
  });

  it('a mix of one completed-and-past stop and one pending-and-late stop returns only the late one', () => {
    const result = findLateStop(
      [
        stop({
          sequence: 1,
          status: 'COMPLETED',
          appointmentDatetime: new Date('2026-09-05T10:00:00.000Z'),
        }),
        stop({
          stopType: 'DELIVERY',
          sequence: 2,
          status: 'PENDING',
          appointmentDatetime: new Date('2026-09-05T19:45:00.000Z'),
        }),
      ],
      NOW,
    );
    expect(result).toEqual({
      stopType: 'DELIVERY',
      appointmentDatetime: new Date('2026-09-05T19:45:00.000Z'),
    });
  });
});

describe("findLateStop — Return Product feature: RETURN stops never distort the standard leg's lateness signal", () => {
  it('a STANDARD stop with a past appointment is late', () => {
    const result = findLateStop([stop({ stopPurpose: 'STANDARD' })], NOW);
    expect(result).not.toBeNull();
  });

  it('a RETURN stop with a past appointment is NOT late', () => {
    const result = findLateStop([stop({ stopPurpose: 'RETURN' })], NOW);
    expect(result).toBeNull();
  });

  it('a Load containing only a late RETURN stop produces no late stop at all', () => {
    const result = findLateStop(
      [
        stop({ stopType: 'PICKUP', sequence: 1, stopPurpose: 'RETURN' }),
        stop({ stopType: 'DELIVERY', sequence: 2, stopPurpose: 'RETURN' }),
      ],
      NOW,
    );
    expect(result).toBeNull();
  });

  it('with both a late STANDARD stop and a late RETURN stop, only the STANDARD one can be returned', () => {
    const result = findLateStop(
      [
        stop({
          stopType: 'PICKUP',
          sequence: 1,
          stopPurpose: 'RETURN',
          appointmentDatetime: new Date('2026-09-05T18:00:00.000Z'), // earlier, but RETURN
        }),
        stop({
          stopType: 'DELIVERY',
          sequence: 2,
          stopPurpose: 'STANDARD',
          appointmentDatetime: new Date('2026-09-05T19:45:00.000Z'),
        }),
      ],
      NOW,
    );
    expect(result).toEqual({
      stopType: 'DELIVERY',
      appointmentDatetime: new Date('2026-09-05T19:45:00.000Z'),
    });
  });

  it('treats a missing stopPurpose as STANDARD (backward-compatible defensive default)', () => {
    // A partial object missing the field entirely — never true for a real
    // DB row, but exactly the defensive case `?? 'STANDARD'` guards
    // against (mirrors LoadStatusDerivationService's own convention).
    const withoutPurpose: Omit<LatenessStopInput, 'stopPurpose'> = {
      stopType: 'PICKUP',
      status: 'PENDING',
      appointmentDatetime: new Date('2026-09-05T19:00:00.000Z'),
      sequence: 1,
    };
    const result = findLateStop([withoutPurpose as LatenessStopInput], NOW);
    expect(result).not.toBeNull();
  });
});
