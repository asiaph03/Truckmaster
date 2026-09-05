import { LoadLatenessSweepService } from './load-lateness-sweep.service';

const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';
// 2026-09-05 15:00 America/New_York (EDT, UTC-4) = 19:00 UTC — an hour before "now" below.
const PAST_APPOINTMENT = new Date('2026-09-05T19:00:00.000Z');
// An hour after "now" below.
const FUTURE_APPOINTMENT = new Date('2026-09-05T21:00:00.000Z');
const NOW = new Date('2026-09-05T20:00:00.000Z');

function stop(overrides: Record<string, unknown> = {}) {
  return {
    stopType: 'DELIVERY',
    status: 'PENDING',
    appointmentDatetime: PAST_APPOINTMENT,
    sequence: 1,
    stopPurpose: 'STANDARD',
    ...overrides,
  };
}

function load(overrides: Record<string, unknown> = {}) {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000019',
    assignedDispatcherId: 'dispatcher-1',
    stops: [stop()],
    ...overrides,
  };
}

function buildService(opts: {
  loads?: Record<string, unknown>[];
  existingUnreadNotification?: boolean;
  orgs?: { id: string }[];
}) {
  const notificationFindFirst = jest
    .fn()
    .mockResolvedValue(opts.existingUnreadNotification ? { id: 'existing-notif' } : null);
  const tx = {
    load: { findMany: jest.fn().mockResolvedValue(opts.loads ?? []) },
    notification: { findFirst: notificationFindFirst },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue(opts.orgs ?? [{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { createForUserAndRoles: jest.fn().mockResolvedValue(undefined) };

  const service = new LoadLatenessSweepService(
    prisma as never,
    audit as never,
    notifications as never,
  );
  return { service, tx, audit, notifications, prisma };
}

// findLateStop's default `now` is `new Date()` (no args) — patching only
// `Date.now` does not affect that (V8 treats them as separate entry
// points into the engine clock), so fake timers are required here to pin
// BOTH consistently. Hoisted to file level (not scoped to a single
// `describe`) so every describe block in this file — including ones added
// later — runs against the same fixed "now", never the real wall clock.
beforeAll(() => {
  jest.useFakeTimers({ now: NOW });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('LoadLatenessSweepService — Cancel Load workflow (CANCELLED loads never notify)', () => {
  it('never queries for a CANCELLED load — the status filter is a fixed operational whitelist that CANCELLED is not part of', async () => {
    const { service, tx } = buildService({ loads: [] });

    await service.run();

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] },
        }),
      }),
    );
    const where = (tx.load.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status.in).not.toContain('CANCELLED');
  });
});

describe('LoadLatenessSweepService — the one backend-owned "Load Late" notification', () => {
  it('notifies the assigned dispatcher when a PENDING stop has a past appointment', async () => {
    const { service, notifications, audit } = buildService({ loads: [load()] });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({
        type: 'LOAD_LATE',
        relatedEntityType: 'Load',
        relatedEntityId: 'load-1',
        message: expect.stringContaining('LOAD-000019'),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Load Late Notification Sent' }),
    );
  });

  it('includes the stop type and a business-timezone-formatted time in the message', async () => {
    const { service, notifications } = buildService({
      loads: [load({ stops: [stop({ stopType: 'DELIVERY' })] })],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({
        message: expect.stringContaining('Delivery appointment: 3:00 PM'),
      }),
    );
  });

  it('does not notify when the stop appointment is still in the future', async () => {
    const { service, notifications } = buildService({
      loads: [load({ stops: [stop({ appointmentDatetime: FUTURE_APPOINTMENT })] })],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('does not notify when the late-appointment stop is already COMPLETED', async () => {
    const { service, notifications } = buildService({
      loads: [load({ stops: [stop({ status: 'COMPLETED' })] })],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('does not notify a Load with no assigned dispatcher (no fallback broadcast)', async () => {
    const { service, notifications } = buildService({
      loads: [load({ assignedDispatcherId: null })],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('handles multiple stops correctly — a completed-and-past stop plus a pending-and-late stop still notifies once, for the late one', async () => {
    const { service, notifications } = buildService({
      loads: [
        load({
          stops: [
            stop({ stopType: 'PICKUP', sequence: 1, status: 'COMPLETED' }),
            stop({ stopType: 'DELIVERY', sequence: 2, status: 'PENDING' }),
          ],
        }),
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledTimes(1);
    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({ message: expect.stringContaining('Delivery appointment') }),
    );
  });

  it('does not create a duplicate LOAD_LATE notification while an unread one already exists for the same Load', async () => {
    const { service, notifications } = buildService({
      loads: [load()],
      existingUnreadNotification: true,
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('is tenant-scoped — never queries or notifies across organizations', async () => {
    const { service, prisma, tx } = buildService({
      orgs: [{ id: ORG_ID }, { id: OTHER_ORG_ID }],
      loads: [load()],
    });

    await service.run();

    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(ORG_ID, expect.any(Function));
    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(OTHER_ORG_ID, expect.any(Function));
    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_ID }) }),
    );
  });

  it("the Admin-visibility fan-out (createForUserAndRoles) is called once per organization with that organization's own id — never a cross-org call", async () => {
    const { service, notifications, prisma } = buildService({
      orgs: [{ id: ORG_ID }, { id: OTHER_ORG_ID }],
      loads: [load()],
    });

    await service.run();

    expect(prisma.withTenantTransaction).toHaveBeenCalledTimes(2);
    expect(notifications.createForUserAndRoles).toHaveBeenCalledTimes(2);
    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.anything(),
    );
    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      OTHER_ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.anything(),
    );
  });
});

describe('LoadLatenessSweepService — Operational Alerts feature: Admin visibility wiring', () => {
  it('requests ADMIN-role fan-out (via NotificationService.createForUserAndRoles) for LOAD_LATE, with the dispatcher as primary recipient', async () => {
    const { service, notifications } = buildService({ loads: [load()] });

    await service.run();

    // Dedup (dispatcher-who-is-also-Admin gets exactly one row) is the
    // responsibility of NotificationService.createForUserAndRoles itself
    // — proven directly against that method in notification.service.spec.ts.
    // This test only proves the sweep asks for the right primary user + roles.
    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({ type: 'LOAD_LATE' }),
    );
  });
});

describe('LoadLatenessSweepService — Return Product feature: RETURN stops never trigger LOAD_LATE', () => {
  it('a Load containing only a late RETURN stop does not notify', async () => {
    const { service, notifications } = buildService({
      loads: [load({ stops: [stop({ stopPurpose: 'RETURN' })] })],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('a Load with a late RETURN stop and a late STANDARD stop still notifies, keyed to the STANDARD one', async () => {
    const { service, notifications } = buildService({
      loads: [
        load({
          stops: [
            stop({ stopType: 'PICKUP', sequence: 1, stopPurpose: 'RETURN' }),
            stop({ stopType: 'DELIVERY', sequence: 2, stopPurpose: 'STANDARD' }),
          ],
        }),
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledTimes(1);
    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({ message: expect.stringContaining('Delivery appointment') }),
    );
  });
});
