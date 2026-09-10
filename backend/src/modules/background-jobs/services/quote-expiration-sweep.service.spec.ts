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

describe('QuoteExpirationSweepService — Monitoring Phase 4A-10 (run summary)', () => {
  it('a zero-record run reports orgsScanned but zero for every other counter, via Logger.log', async () => {
    const { service } = buildService([]);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    expect(logSpy).toHaveBeenCalledWith(
      'Quote expiration sweep summary: orgsScanned=1 recordsMatched=0 recordsSucceeded=0 recordsFailed=0',
    );
    logSpy.mockRestore();
  });

  it('an all-success run reports matched === succeeded, via Logger.log', async () => {
    const { service } = buildService([
      { id: 'quote-1', status: 'OPEN', expirationDate: new Date('2020-01-01') },
      { id: 'quote-2', status: 'OPEN', expirationDate: new Date('2020-01-01') },
    ]);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    expect(logSpy).toHaveBeenCalledWith(
      'Quote expiration sweep summary: orgsScanned=1 recordsMatched=2 recordsSucceeded=2 recordsFailed=0',
    );
    logSpy.mockRestore();
  });

  it('a mixed success/failure run across multiple orgs reports exact counts and escalates to Logger.warn', async () => {
    const ok1 = { id: 'quote-ok1', status: 'OPEN', expirationDate: new Date('2020-01-01') };
    const fail1 = { id: 'quote-fail1', status: 'OPEN', expirationDate: new Date('2020-01-01') };
    const ok2 = { id: 'quote-ok2', status: 'OPEN', expirationDate: new Date('2020-01-01') };

    const tx = {
      quote: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: { organizationId: string } }) =>
            Promise.resolve(where.organizationId === ORG_ID ? [ok1, fail1] : [ok2]),
          ),
        update: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === 'quote-fail1') throw new Error('simulated DB failure');
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
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new QuoteExpirationSweepService(prisma as never, audit as never, notifications as never);

    await service.run();

    expect(warnSpy).toHaveBeenCalledWith(
      'Quote expiration sweep summary: orgsScanned=2 recordsMatched=3 recordsSucceeded=2 recordsFailed=1',
    );

    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('a successful transaction increments recordsSucceeded and never recordsFailed for the same record', async () => {
    const { service } = buildService([
      { id: 'quote-1', status: 'OPEN', expirationDate: new Date('2020-01-01') },
    ]);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    expect(message).toContain('recordsSucceeded=1');
    expect(message).toContain('recordsFailed=0');
    logSpy.mockRestore();
  });

  it('an organization-level query failure counts toward orgsScanned, contributes 0 to recordsMatched, and does not increment recordsFailed', async () => {
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest.fn().mockRejectedValue(new Error('org query failed')),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForUserAndRoles: jest.fn().mockResolvedValue(undefined) };
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new QuoteExpirationSweepService(prisma as never, audit as never, notifications as never);

    await service.run();

    expect(logSpy).toHaveBeenCalledWith(
      'Quote expiration sweep summary: orgsScanned=1 recordsMatched=0 recordsSucceeded=0 recordsFailed=0',
    );
    logSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('matched count equals the existing candidate query result length', async () => {
    const { service } = buildService([
      { id: 'q1', status: 'OPEN', expirationDate: new Date('2020-01-01') },
      { id: 'q2', status: 'OPEN', expirationDate: new Date('2020-01-01') },
      { id: 'q3', status: 'OPEN', expirationDate: new Date('2020-01-01') },
    ]);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    expect(message).toContain('recordsMatched=3');
    logSpy.mockRestore();
  });

  it('security/PII — the summary log contains only aggregate counts, never entity ids or PII', async () => {
    const { service } = buildService([
      { id: 'quote-1', status: 'OPEN', expirationDate: new Date('2020-01-01') },
    ]);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    expect(message).not.toContain('quote-1');
    expect(message).toMatch(/^Quote expiration sweep summary: orgsScanned=\d+ recordsMatched=\d+ recordsSucceeded=\d+ recordsFailed=\d+$/);
    logSpy.mockRestore();
  });
});
