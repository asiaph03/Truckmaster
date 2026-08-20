import { NotificationService } from './notification.service';
import { NotFoundError } from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

function buildService(
  opts: {
    memberships?: { userId: string }[];
    existing?: Record<string, unknown> | null;
    notifications?: Record<string, unknown>[];
  } = {},
) {
  const tx = {
    notification: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'notif-1', ...data })),
      findMany: jest.fn().mockResolvedValue(opts.notifications ?? []),
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
