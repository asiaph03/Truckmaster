import { CheckCallReminderSweepService } from './check-call-reminder-sweep.service';

const ORG_ID = 'org-1';
const FIVE_HOURS_AGO = new Date(Date.now() - 5 * 60 * 60 * 1000);
const ONE_HOUR_AGO = new Date(Date.now() - 1 * 60 * 60 * 1000);

function buildService(loads: Record<string, unknown>[] = []) {
  const tx = {
    load: { findMany: jest.fn().mockResolvedValue(loads) },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { create: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(4) };

  const service = new CheckCallReminderSweepService(
    prisma as never,
    audit as never,
    notifications as never,
    config as never,
  );
  return { service, tx, audit, notifications, config, prisma };
}

describe('CheckCallReminderSweepService — TECHNICAL_ARCHITECTURE.md §10.1 (B1 resolved, 4h)', () => {
  it('notifies the assigned dispatcher when the most recent check call exceeds the interval', async () => {
    const { service, notifications, audit } = buildService([
      {
        id: 'load-1',
        loadNumber: 'LOAD-000001',
        assignedDispatcherId: 'dispatcher-1',
        dispatchRecord: { dispatchedAt: FIVE_HOURS_AGO },
        checkCalls: [],
      },
    ]);

    await service.run();

    expect(notifications.create).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      expect.objectContaining({
        recipientUserId: 'dispatcher-1',
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
    const { service, notifications } = buildService([
      {
        id: 'load-1',
        loadNumber: 'LOAD-000001',
        assignedDispatcherId: 'dispatcher-1',
        dispatchRecord: { dispatchedAt: FIVE_HOURS_AGO },
        checkCalls: [{ occurredAt: ONE_HOUR_AGO }],
      },
    ]);

    await service.run();

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('skips a Load with no assigned dispatcher (Decision 5 — no fallback broadcast)', async () => {
    const { service, notifications } = buildService([
      {
        id: 'load-1',
        loadNumber: 'LOAD-000001',
        assignedDispatcherId: null,
        dispatchRecord: { dispatchedAt: FIVE_HOURS_AGO },
        checkCalls: [],
      },
    ]);

    await service.run();

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('does not notify when the load is still within the interval', async () => {
    const { service, notifications } = buildService([
      {
        id: 'load-1',
        loadNumber: 'LOAD-000001',
        assignedDispatcherId: 'dispatcher-1',
        dispatchRecord: { dispatchedAt: ONE_HOUR_AGO },
        checkCalls: [],
      },
    ]);

    await service.run();

    expect(notifications.create).not.toHaveBeenCalled();
  });
});
