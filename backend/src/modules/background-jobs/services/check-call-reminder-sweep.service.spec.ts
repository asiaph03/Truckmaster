import { CheckCallReminderSweepService } from './check-call-reminder-sweep.service';

const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';
const FIVE_HOURS_AGO = new Date(Date.now() - 5 * 60 * 60 * 1000);
const ONE_HOUR_AGO = new Date(Date.now() - 1 * 60 * 60 * 1000);
// 4h threshold, 15-min due-soon lead: 3h50m ago is inside the due-soon window (3h45m-4h).
const THREE_H_FIFTY_M_AGO = new Date(Date.now() - (3 * 60 + 50) * 60 * 1000);
// Just outside the due-soon window (more than 15 min before the threshold).
const THREE_H_THIRTY_M_AGO = new Date(Date.now() - (3 * 60 + 30) * 60 * 1000);
// Exactly at the due-soon boundary: threshold - 15min.
const EXACTLY_THREE_H_FORTY_FIVE_M_AGO = new Date(Date.now() - (3 * 60 + 45) * 60 * 1000);

function buildService(opts: {
  loads?: Record<string, unknown>[];
  existingUnreadOverdue?: boolean;
  existingUnreadDueSoon?: boolean;
  orgs?: { id: string }[];
}) {
  const notificationFindFirst = jest
    .fn()
    .mockImplementation(({ where }: { where: { type: string } }) => {
      if (where.type === 'CHECK_CALL_OVERDUE') {
        return Promise.resolve(opts.existingUnreadOverdue ? { id: 'existing-overdue' } : null);
      }
      if (where.type === 'CHECK_CALL_DUE_SOON') {
        return Promise.resolve(opts.existingUnreadDueSoon ? { id: 'existing-due-soon' } : null);
      }
      return Promise.resolve(null);
    });
  const notificationUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

  const tx = {
    load: { findMany: jest.fn().mockResolvedValue(opts.loads ?? []) },
    notification: { findFirst: notificationFindFirst, updateMany: notificationUpdateMany },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue(opts.orgs ?? [{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { createForUserAndRoles: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(4) };

  const service = new CheckCallReminderSweepService(
    prisma as never,
    audit as never,
    notifications as never,
    config as never,
  );
  return { service, tx, audit, notifications, config, prisma };
}

describe('CheckCallReminderSweepService — Cancel Load workflow (CANCELLED loads never notify)', () => {
  it('never queries for a CANCELLED load — the status filter is a fixed in-transit whitelist that CANCELLED is not part of', async () => {
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

describe('CheckCallReminderSweepService — CHECK_CALL_OVERDUE (existing rule, unchanged threshold)', () => {
  it('notifies the assigned dispatcher when the most recent check call exceeds the interval', async () => {
    const { service, notifications, audit } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({
        type: 'CHECK_CALL_OVERDUE',
        relatedEntityId: 'load-1',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Check Call Overdue Reminder Sent' }),
    );
  });

  it('uses the most recent CheckCall.occurredAt over the dispatch time when one exists', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [{ occurredAt: ONE_HOUR_AGO }],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('skips a Load with no assigned dispatcher (Decision 5 — no fallback broadcast)', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: null,
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('does not notify when the load is still well within the interval', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: ONE_HOUR_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('resolves the driver name via live sourceDriver over the DispatchRecord snapshot, matching the LoadSummary precedence rule', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Stale Snapshot Name',
            sourceDriver: { firstName: 'Jane', lastName: 'Smith' },
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({ message: expect.stringContaining('Driver: Jane Smith') }),
    );
  });

  it('omits the driver line entirely (no "undefined"/"null") when no dispatch record exists', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: null,
          checkCalls: [{ occurredAt: FIVE_HOURS_AGO }],
        },
      ],
    });

    await service.run();

    const call = notifications.createForUserAndRoles.mock.calls[0][4];
    expect(call.message).not.toMatch(/undefined/i);
    expect(call.message).not.toMatch(/\bnull\b/i);
    expect(call.message).not.toContain('Driver:');
  });

  it('does not create a duplicate CHECK_CALL_OVERDUE notification while an unread one already exists for the same Load', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
      existingUnreadOverdue: true,
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('supersedes (marks read) any outstanding unread CHECK_CALL_DUE_SOON notification the moment the Load becomes overdue', async () => {
    const { service, tx } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(tx.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: 'CHECK_CALL_DUE_SOON',
          relatedEntityId: 'load-1',
          read: false,
        }),
        data: { read: true },
      }),
    );
  });
});

describe('CheckCallReminderSweepService — CHECK_CALL_DUE_SOON (new: 15-minute lead time)', () => {
  it('does not notify before the due-soon window (more than 15 minutes before the threshold)', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: THREE_H_THIRTY_M_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('notifies CHECK_CALL_DUE_SOON exactly at threshold minus 15 minutes', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: EXACTLY_THREE_H_FORTY_FIVE_M_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({ type: 'CHECK_CALL_DUE_SOON', relatedEntityId: 'load-1' }),
    );
  });

  it('notifies CHECK_CALL_DUE_SOON inside the 15-minute window', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: THREE_H_FIFTY_M_AGO,
            driverName: 'Charles Jaynes',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({
        type: 'CHECK_CALL_DUE_SOON',
        message: expect.stringMatching(/Driver: Charles Jaynes · Due in \d+ min/),
      }),
    );
  });

  it('fires CHECK_CALL_OVERDUE, never a CHECK_CALL_DUE_SOON duplicate, once actually overdue', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledTimes(1);
    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({ type: 'CHECK_CALL_OVERDUE' }),
    );
  });

  it('does not create a duplicate CHECK_CALL_DUE_SOON notification while an unread one already exists for the same Load', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: THREE_H_FIFTY_M_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
      existingUnreadDueSoon: true,
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });
});

describe('CheckCallReminderSweepService — Operational Alerts feature: Admin visibility wiring', () => {
  it('requests ADMIN-role fan-out (via NotificationService.createForUserAndRoles) for CHECK_CALL_OVERDUE, with the dispatcher as primary recipient', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

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
      expect.objectContaining({ type: 'CHECK_CALL_OVERDUE' }),
    );
  });

  it('requests ADMIN-role fan-out for CHECK_CALL_DUE_SOON, with the dispatcher as primary recipient', async () => {
    const { service, notifications } = buildService({
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: THREE_H_FIFTY_M_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'dispatcher-1',
      ['ADMIN'],
      expect.objectContaining({ type: 'CHECK_CALL_DUE_SOON' }),
    );
  });
});

describe('CheckCallReminderSweepService — tenant isolation', () => {
  it('scopes every org independently through withTenantTransaction, never a cross-org query', async () => {
    const { service, prisma, tx } = buildService({
      orgs: [{ id: ORG_ID }, { id: OTHER_ORG_ID }],
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
    });

    await service.run();

    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(ORG_ID, expect.any(Function));
    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(OTHER_ORG_ID, expect.any(Function));
    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_ID }) }),
    );
    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: OTHER_ORG_ID }) }),
    );
  });

  it("the Admin-visibility fan-out (createForUserAndRoles) is called once per organization with that organization's own id — never a cross-org call", async () => {
    const { service, notifications, prisma } = buildService({
      orgs: [{ id: ORG_ID }, { id: OTHER_ORG_ID }],
      loads: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000001',
          assignedDispatcherId: 'dispatcher-1',
          dispatchRecord: {
            dispatchedAt: FIVE_HOURS_AGO,
            driverName: 'Manual Driver',
            sourceDriver: null,
          },
          checkCalls: [],
        },
      ],
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
