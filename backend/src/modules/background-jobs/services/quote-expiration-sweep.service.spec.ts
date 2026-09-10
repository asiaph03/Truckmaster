import { Logger } from '@nestjs/common';
import { QuoteExpirationSweepService } from './quote-expiration-sweep.service';

const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';

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

describe('QuoteExpirationSweepService — Monitoring Phase 4A-2 (per-record error isolation)', () => {
  it('a failing quote does not abort the rest of that org or subsequent orgs, and logs org+entity correlation', async () => {
    const failing = { id: 'quote-fail', quoteNumber: 'QT-FAIL', status: 'OPEN', expirationDate: new Date('2020-01-01'), createdByUserId: 'user-1' };
    const ok = { id: 'quote-ok', quoteNumber: 'QT-OK', status: 'OPEN', expirationDate: new Date('2020-01-01'), createdByUserId: 'user-1' };
    const org2Record = { id: 'quote-org2', quoteNumber: 'QT-ORG2', status: 'OPEN', expirationDate: new Date('2020-01-01'), createdByUserId: 'user-1' };

    const tx = {
      quote: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: { organizationId: string } }) =>
            Promise.resolve(where.organizationId === ORG_ID ? [failing, ok] : [org2Record]),
          ),
        update: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === 'quote-fail') throw new Error('simulated DB failure');
          return { id: where.id, status: 'LOST' };
        }),
      },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }, { id: OTHER_ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForUserAndRoles: jest.fn().mockResolvedValue(undefined) };
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new QuoteExpirationSweepService(prisma as never, audit as never, notifications as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(tx.quote.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'quote-ok' } }));
    expect(tx.quote.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'quote-org2' } }));

    const failureLog = errorSpy.mock.calls.find((c) => String(c[0]).includes('quote-fail'));
    expect(failureLog).toBeDefined();
    expect(failureLog![0]).toContain(ORG_ID);
    expect(failureLog![0]).toContain('quote-fail');

    errorSpy.mockRestore();
  });
});
