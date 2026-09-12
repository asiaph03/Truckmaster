import { Logger } from '@nestjs/common';
import { CarrierComplianceExpirationSweepService } from './carrier-compliance-expiration-sweep.service';

const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';

function buildService(
  opts: { staleDocs?: Record<string, unknown>[]; activeCarriers?: { id: string }[] } = {},
) {
  const tx = {
    document: {
      findMany: jest.fn().mockResolvedValue(opts.staleDocs ?? []),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
    },
    carrier: {
      findMany: jest.fn().mockResolvedValue(opts.activeCarriers ?? [{ id: 'carrier-1' }]),
    },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const carrierEligibility = {
    recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }),
  };

  const service = new CarrierComplianceExpirationSweepService(
    prisma as never,
    audit as never,
    carrierEligibility as never,
  );
  return { service, tx, audit, carrierEligibility, prisma };
}

describe('CarrierComplianceExpirationSweepService — Workflow 3 §3.9', () => {
  it('flips stale MC Authority/Notice of Assignment documents to EXPIRED and audits each', async () => {
    const { service, tx, audit } = buildService({
      staleDocs: [{ id: 'doc-1' }, { id: 'doc-2' }],
    });

    await service.run();

    expect(tx.document.update).toHaveBeenCalledTimes(2);
    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reviewStatus: 'EXPIRED' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Compliance Item Expired', actorType: 'SYSTEM' }),
    );
  });

  it('recalculates eligibility for every Active carrier, reusing CarrierEligibilityService unmodified', async () => {
    const { service, carrierEligibility } = buildService({
      activeCarriers: [{ id: 'carrier-1' }, { id: 'carrier-2' }],
    });

    await service.run();

    expect(carrierEligibility.recalculate).toHaveBeenCalledTimes(2);
    expect(carrierEligibility.recalculate).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'carrier-1',
    );
    expect(carrierEligibility.recalculate).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'carrier-2',
    );
  });
});

describe('CarrierComplianceExpirationSweepService — Monitoring Phase 4A-2 (per-record error isolation)', () => {
  it('a failing document update does not abort the rest of that org or subsequent orgs, and logs org+entity correlation', async () => {
    const tx = {
      document: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: { organizationId: string } }) =>
            Promise.resolve(
              where.organizationId === ORG_ID
                ? [{ id: 'doc-fail' }, { id: 'doc-ok' }]
                : [{ id: 'doc-org2' }],
            ),
          ),
        update: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === 'doc-fail') throw new Error('simulated DB failure');
          return { id: where.id, reviewStatus: 'EXPIRED' };
        }),
      },
      carrier: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }, { id: OTHER_ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(tx.document.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'doc-ok' } }));
    expect(tx.document.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'doc-org2' } }));

    const failureLog = errorSpy.mock.calls.find((c) => String(c[0]).includes('doc-fail'));
    expect(failureLog).toBeDefined();
    expect(failureLog![0]).toContain(ORG_ID);
    expect(failureLog![0]).toContain('doc-fail');

    errorSpy.mockRestore();
  });

  it('a failing carrier eligibility recalculation does not abort the rest of that org or subsequent orgs, and logs org+entity correlation', async () => {
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      carrier: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: { organizationId: string } }) =>
            Promise.resolve(
              where.organizationId === ORG_ID
                ? [{ id: 'carrier-fail' }, { id: 'carrier-ok' }]
                : [{ id: 'carrier-org2' }],
            ),
          ),
      },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }, { id: OTHER_ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = {
      recalculate: jest.fn().mockImplementation((_tx: unknown, _orgId: string, carrierId: string) => {
        if (carrierId === 'carrier-fail') throw new Error('simulated recalculation failure');
        return Promise.resolve({ eligible: true, reasons: [] });
      }),
    };
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(carrierEligibility.recalculate).toHaveBeenCalledWith(expect.anything(), ORG_ID, 'carrier-ok');
    expect(carrierEligibility.recalculate).toHaveBeenCalledWith(expect.anything(), OTHER_ORG_ID, 'carrier-org2');

    const failureLog = errorSpy.mock.calls.find((c) => String(c[0]).includes('carrier-fail'));
    expect(failureLog).toBeDefined();
    expect(failureLog![0]).toContain(ORG_ID);
    expect(failureLog![0]).toContain('carrier-fail');

    errorSpy.mockRestore();
  });
});

describe('CarrierComplianceExpirationSweepService — Monitoring Phase 4A-10 (run summary)', () => {
  it('a zero-record run reports orgsScanned but zero for every other counter, via Logger.log', async () => {
    const { service } = buildService({ staleDocs: [], activeCarriers: [] });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    expect(logSpy).toHaveBeenCalledWith(
      'Carrier compliance expiration sweep summary: orgsScanned=1 documentsMatched=0 documentsSucceeded=0 documentsFailed=0 carriersMatched=0 carriersSucceeded=0 carriersFailed=0',
    );
    logSpy.mockRestore();
  });

  it('document and carrier counters are tracked independently — all active carriers count as carriersMatched (the full recalculation pass, not a filtered subset)', async () => {
    const { service } = buildService({
      staleDocs: [{ id: 'doc-1' }, { id: 'doc-2' }],
      activeCarriers: [{ id: 'carrier-1' }, { id: 'carrier-2' }, { id: 'carrier-3' }],
    });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    expect(logSpy).toHaveBeenCalledWith(
      'Carrier compliance expiration sweep summary: orgsScanned=1 documentsMatched=2 documentsSucceeded=2 documentsFailed=0 carriersMatched=3 carriersSucceeded=3 carriersFailed=0',
    );
    logSpy.mockRestore();
  });

  it('document failures affect only documentsFailed, never carriersFailed', async () => {
    const tx = {
      document: {
        findMany: jest.fn().mockResolvedValue([{ id: 'doc-fail' }, { id: 'doc-ok' }]),
        update: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === 'doc-fail') throw new Error('simulated DB failure');
          return { id: where.id, reviewStatus: 'EXPIRED' };
        }),
      },
      carrier: { findMany: jest.fn().mockResolvedValue([{ id: 'carrier-1' }]) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await service.run();

    expect(warnSpy).toHaveBeenCalledWith(
      'Carrier compliance expiration sweep summary: orgsScanned=1 documentsMatched=2 documentsSucceeded=1 documentsFailed=1 carriersMatched=1 carriersSucceeded=1 carriersFailed=0',
    );
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('carrier recalculation failures affect only carriersFailed, never documentsFailed', async () => {
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([{ id: 'doc-1' }]), update: jest.fn().mockReturnValue({ id: 'doc-1' }) },
      carrier: { findMany: jest.fn().mockResolvedValue([{ id: 'carrier-fail' }, { id: 'carrier-ok' }]) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = {
      recalculate: jest.fn().mockImplementation((_tx: unknown, _orgId: string, carrierId: string) => {
        if (carrierId === 'carrier-fail') throw new Error('simulated recalculation failure');
        return Promise.resolve({ eligible: true, reasons: [] });
      }),
    };
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await service.run();

    expect(warnSpy).toHaveBeenCalledWith(
      'Carrier compliance expiration sweep summary: orgsScanned=1 documentsMatched=1 documentsSucceeded=1 documentsFailed=0 carriersMatched=2 carriersSucceeded=1 carriersFailed=1',
    );
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('a document-query failure contributes 0 to documentsMatched without touching the carrier pass', async () => {
    const tx = {
      document: { findMany: jest.fn(), update: jest.fn() },
      carrier: { findMany: jest.fn().mockResolvedValue([{ id: 'carrier-1' }]) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest.fn().mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => {
        // First withTenantTransaction call is loadStaleDocs — fail it.
        if ((prisma.withTenantTransaction as jest.Mock).mock.calls.length === 1) {
          return Promise.reject(new Error('doc query failed'));
        }
        return fn(tx);
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await service.run();

    expect(logSpy).toHaveBeenCalledWith(
      'Carrier compliance expiration sweep summary: orgsScanned=1 documentsMatched=0 documentsSucceeded=0 documentsFailed=0 carriersMatched=1 carriersSucceeded=1 carriersFailed=0',
    );
    logSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('security/PII — the summary log contains only aggregate counts, never entity ids or PII', async () => {
    const { service } = buildService({ staleDocs: [{ id: 'doc-1' }], activeCarriers: [{ id: 'carrier-1' }] });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    expect(message).not.toContain('doc-1');
    expect(message).not.toContain('carrier-1');
    expect(message).toMatch(
      /^Carrier compliance expiration sweep summary: orgsScanned=\d+ documentsMatched=\d+ documentsSucceeded=\d+ documentsFailed=\d+ carriersMatched=\d+ carriersSucceeded=\d+ carriersFailed=\d+$/,
    );
    logSpy.mockRestore();
  });
});

describe('CarrierComplianceExpirationSweepService — Monitoring Phase 4A-17 (sanitized error logging)', () => {
  const SENSITIVE_MARKER = 'SENSITIVE_PRISMA_ERROR_CONTENT';

  function sensitivePrismaError(): Error {
    return Object.assign(new Error(SENSITIVE_MARKER), {
      stack: `Error: ${SENSITIVE_MARKER}\n    at fake-stack (${SENSITIVE_MARKER})`,
      meta: { target: [SENSITIVE_MARKER] },
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the loadStaleDocs (candidate-query) failure log contains only org correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest.fn().mockRejectedValue(sensitivePrismaError()),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      `Carrier compliance expiration sweep: failed to load stale documents for org ${ORG_ID}. errorType=Error`,
    );
  });

  it('SECURITY — the loadStaleDocs failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest.fn().mockRejectedValue(sensitivePrismaError()),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('the per-document failure log contains only org+entity correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: {
        findMany: jest.fn().mockResolvedValue([{ id: 'doc-fail' }]),
        update: jest.fn().mockRejectedValue(sensitivePrismaError()),
      },
      carrier: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await service.run();

    expect(errorSpy).toHaveBeenCalledWith(
      `Carrier compliance expiration sweep: failed to expire document for org ${ORG_ID}, document doc-fail. errorType=Error`,
    );
  });

  it('SECURITY — the per-document failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: {
        findMany: jest.fn().mockResolvedValue([{ id: 'doc-fail' }]),
        update: jest.fn().mockRejectedValue(sensitivePrismaError()),
      },
      carrier: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('the loadActiveCarriers (candidate-query) failure log contains only org correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      carrier: { findMany: jest.fn() },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => {
          // First call is loadStaleDocs (must succeed, empty); second call is loadActiveCarriers (must fail).
          if (fn.toString().includes('document.findMany')) return fn(tx);
          return Promise.reject(sensitivePrismaError());
        }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      `Carrier compliance expiration sweep: failed to load active carriers for org ${ORG_ID}. errorType=Error`,
    );
  });

  it('SECURITY — the loadActiveCarriers failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      carrier: { findMany: jest.fn() },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => {
          if (fn.toString().includes('document.findMany')) return fn(tx);
          return Promise.reject(sensitivePrismaError());
        }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }) };
    const service = new CarrierComplianceExpirationSweepService(prisma as never, audit as never, carrierEligibility as never);

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('the per-carrier failure log contains only org+entity correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, carrierEligibility } = buildService({
      staleDocs: [],
      activeCarriers: [{ id: 'carrier-fail' }],
    });
    (carrierEligibility.recalculate as jest.Mock).mockRejectedValue(sensitivePrismaError());

    await service.run();

    expect(errorSpy).toHaveBeenCalledWith(
      `Carrier compliance expiration sweep: failed to recalculate eligibility for org ${ORG_ID}, carrier carrier-fail. errorType=Error`,
    );
  });

  it('SECURITY — the per-carrier failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, carrierEligibility } = buildService({
      staleDocs: [],
      activeCarriers: [{ id: 'carrier-fail' }],
    });
    (carrierEligibility.recalculate as jest.Mock).mockRejectedValue(sensitivePrismaError());

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });
});
