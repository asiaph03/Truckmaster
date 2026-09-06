import { QuoteExpirationSweepService } from './quote-expiration-sweep.service';

const ORG_ID = 'org-1';

function buildService(
  quotes: Record<string, unknown>[] = [],
  opts: { existingNotification?: Record<string, unknown> | null } = {},
) {
  const tx = {
    quote: {
      findMany: jest.fn().mockResolvedValue(quotes),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'quote-1', ...data })),
    },
    notification: {
      findFirst: jest.fn().mockResolvedValue(opts.existingNotification ?? null),
    },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { createForUserAndRoles: jest.fn().mockResolvedValue(undefined) };

  const service = new QuoteExpirationSweepService(
    prisma as never,
    audit as never,
    notifications as never,
  );
  return { service, tx, audit, prisma, notifications };
}

describe('QuoteExpirationSweepService — Workflow 4 §4.5', () => {
  it('marks every stale OPEN quote LOST with an automatic loss reason', async () => {
    const { service, tx, audit } = buildService([
      { id: 'quote-1', status: 'OPEN', expirationDate: new Date('2020-01-01') },
    ]);

    await service.run();

    expect(tx.quote.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'LOST', lossReason: 'Expired' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'Quote Expired — Automatically Marked Lost',
        actorType: 'SYSTEM',
      }),
    );
  });

  it('does nothing when there are no stale OPEN quotes', async () => {
    const { service, tx } = buildService([]);

    await service.run();

    expect(tx.quote.update).not.toHaveBeenCalled();
  });
});

describe('QuoteExpirationSweepService — QUOTE_EXPIRED notification (Task #9)', () => {
  const QUOTE = {
    id: 'quote-1',
    quoteNumber: 'QT-000001',
    status: 'OPEN',
    expirationDate: new Date('2020-01-01'),
    createdByUserId: 'creator-1',
  };

  it('notifies the creator + ADMIN when a Quote expires', async () => {
    const { service, notifications } = buildService([QUOTE]);

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'creator-1',
      ['ADMIN'],
      expect.objectContaining({
        type: 'QUOTE_EXPIRED',
        relatedEntityType: 'Quote',
        relatedEntityId: 'quote-1',
      }),
    );
  });

  it('does not create a duplicate QUOTE_EXPIRED notification when one already exists', async () => {
    const { service, notifications } = buildService([QUOTE], {
      existingNotification: { id: 'existing-notif' },
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('is tenant-scoped — the notification dedup check and creation both use the org being swept', async () => {
    const { service, tx, notifications } = buildService([QUOTE]);

    await service.run();

    expect(tx.notification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_ID }) }),
    );
    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
