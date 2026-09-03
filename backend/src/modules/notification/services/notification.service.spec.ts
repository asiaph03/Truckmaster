import { NotificationService } from './notification.service';
import { NotFoundError } from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

function buildService(
  opts: {
    memberships?: { userId: string }[];
    existing?: Record<string, unknown> | null;
    notifications?: Record<string, unknown>[];
    unreadCount?: number;
  } = {},
) {
  const tx = {
    notification: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'notif-1', ...data })),
      findMany: jest.fn().mockResolvedValue(opts.notifications ?? []),
      count: jest.fn().mockResolvedValue(opts.unreadCount ?? 0),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'existing' in opts
            ? opts.existing
            : { id: 'notif-1', organizationId: ORG_ID, recipientUserId: USER_ID },
        ),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'notif-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    organizationMembership: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.memberships ?? [{ userId: 'opsmgr-1' }, { userId: 'reviewer-1' }]),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const service = new NotificationService(prisma as never);
  return { service, tx, prisma };
}

describe('NotificationService.create', () => {
  it('creates a notification row for the given recipient', async () => {
    const { service, tx } = buildService();

    await service.create(tx as never, ORG_ID, {
      recipientUserId: USER_ID,
      type: 'CHECK_CALL_OVERDUE',
      message: 'Load LOAD-000001 has gone quiet.',
      relatedEntityType: 'Load',
      relatedEntityId: 'load-1',
    });

    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: ORG_ID, recipientUserId: USER_ID }),
      }),
    );
  });
});

describe('NotificationService.createForRoles — Workflow 3 §3.10 role fan-out', () => {
  it('creates one notification per Active member holding any of the given roles', async () => {
    const { service, tx } = buildService({
      memberships: [{ userId: 'opsmgr-1' }, { userId: 'reviewer-1' }],
    });

    await service.createForRoles(
      tx as never,
      ORG_ID,
      ['OPERATIONS_MANAGER', 'COMPLIANCE_REVIEWER'],
      {
        type: 'COMPLIANCE_EXPIRING_30_DAY',
        message: 'MC Authority expiring in 30 days for Acme Trucking.',
      },
    );

    expect(tx.organizationMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID, status: 'ACTIVE' }),
      }),
    );
    expect(tx.notification.create).toHaveBeenCalledTimes(2);
  });

  it('creates zero notifications when no member holds the target roles', async () => {
    const { service, tx } = buildService({ memberships: [] });

    await service.createForRoles(tx as never, ORG_ID, ['OPERATIONS_MANAGER'], {
      type: 'COMPLIANCE_EXPIRING_7_DAY',
      message: 'x',
    });

    expect(tx.notification.create).not.toHaveBeenCalled();
  });
});

describe('NotificationService.createForUserAndRoles — Operational Alerts feature: dispatcher + Admin visibility', () => {
  it('notifies the primary user (dispatcher) plus every ACTIVE member holding the given roles', async () => {
    const { service, tx } = buildService({
      memberships: [{ userId: 'admin-1' }, { userId: 'admin-2' }],
    });

    await service.createForUserAndRoles(tx as never, ORG_ID, 'dispatcher-1', ['ADMIN'], {
      type: 'CHECK_CALL_OVERDUE',
      relatedEntityType: 'Load',
      relatedEntityId: 'load-1',
      message: 'Load LOAD-000001 has gone quiet.',
    });

    expect(tx.organizationMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          status: 'ACTIVE',
          roles: { some: { role: { in: ['ADMIN'] } } },
        }),
      }),
    );
    expect(tx.notification.create).toHaveBeenCalledTimes(3);
    const recipients = tx.notification.create.mock.calls.map((c) => c[0].data.recipientUserId);
    expect(recipients.sort()).toEqual(['admin-1', 'admin-2', 'dispatcher-1']);
  });

  it('sends exactly one notification when the dispatcher is also an Admin member (dedup by userId)', async () => {
    const { service, tx } = buildService({
      memberships: [{ userId: 'dispatcher-1' }, { userId: 'admin-2' }],
    });

    await service.createForUserAndRoles(tx as never, ORG_ID, 'dispatcher-1', ['ADMIN'], {
      type: 'LOAD_LATE',
      relatedEntityType: 'Load',
      relatedEntityId: 'load-1',
      message: 'Load late.',
    });

    expect(tx.notification.create).toHaveBeenCalledTimes(2);
    const recipients = tx.notification.create.mock.calls.map((c) => c[0].data.recipientUserId);
    expect(recipients.sort()).toEqual(['admin-2', 'dispatcher-1']);
    expect(recipients.filter((r) => r === 'dispatcher-1')).toHaveLength(1);
  });

  it('still notifies the primary user alone when no member holds the target roles', async () => {
    const { service, tx } = buildService({ memberships: [] });

    await service.createForUserAndRoles(tx as never, ORG_ID, 'dispatcher-1', ['ADMIN'], {
      type: 'CHECK_CALL_DUE_SOON',
      relatedEntityType: 'Load',
      relatedEntityId: 'load-1',
      message: 'Due soon.',
    });

    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipientUserId: 'dispatcher-1' }),
      }),
    );
  });

  it('only queries ACTIVE memberships within the given organization — never a cross-org fan-out', async () => {
    const { service, tx } = buildService({ memberships: [{ userId: 'admin-1' }] });

    await service.createForUserAndRoles(tx as never, ORG_ID, 'dispatcher-1', ['ADMIN'], {
      type: 'LOAD_LATE',
      relatedEntityType: 'Load',
      relatedEntityId: 'load-1',
      message: 'Load late.',
    });

    expect(tx.organizationMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID, status: 'ACTIVE' }),
      }),
    );
    const orgIdsWritten = tx.notification.create.mock.calls.map((c) => c[0].data.organizationId);
    expect(orgIdsWritten.every((id) => id === ORG_ID)).toBe(true);
  });
});

describe('NotificationService.list', () => {
  it('defaults to page 1 / pageSize 20, filtered to the caller as recipient', async () => {
    const { service, tx } = buildService();

    await service.list(ORG_ID, USER_ID, {});

    expect(tx.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, recipientUserId: USER_ID },
        skip: 0,
        take: 20,
      }),
    );
  });

  it('applies the unreadOnly filter and caps pageSize at 100', async () => {
    const { service, tx } = buildService();

    await service.list(ORG_ID, USER_ID, { unreadOnly: true, page: 2, pageSize: 500 });

    expect(tx.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, recipientUserId: USER_ID, read: false },
        skip: 100,
        take: 100,
      }),
    );
  });
});

describe('NotificationService.countUnread — authoritative badge count, not derived from a paginated page', () => {
  it('returns the tenant/recipient-scoped unread count', async () => {
    const { service, tx } = buildService({ unreadCount: 42 });

    const result = await service.countUnread(ORG_ID, USER_ID);

    expect(result).toBe(42);
    expect(tx.notification.count).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, recipientUserId: USER_ID, read: false },
    });
  });
});

describe('NotificationService.markRead / markAllRead', () => {
  it('marks a single notification read', async () => {
    const { service, tx } = buildService();

    const result = await service.markRead(ORG_ID, USER_ID, 'notif-1');

    expect(result.read).toBe(true);
    expect(tx.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { read: true } }),
    );
  });

  it('throws NotFoundError for a notification not owned by the caller', async () => {
    const { service } = buildService({ existing: null });

    await expect(service.markRead(ORG_ID, USER_ID, 'notif-1')).rejects.toThrow(NotFoundError);
  });

  it('marks every unread notification for the caller read and returns the count', async () => {
    const { service, tx } = buildService();

    const result = await service.markAllRead(ORG_ID, USER_ID);

    expect(result.count).toBe(3);
    expect(tx.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, recipientUserId: USER_ID, read: false },
      }),
    );
  });
});
