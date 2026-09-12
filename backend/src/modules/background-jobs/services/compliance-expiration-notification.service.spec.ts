import { Logger } from '@nestjs/common';
import { ComplianceExpirationNotificationService } from './compliance-expiration-notification.service';

const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';

const EXPIRING_DOC = {
  id: 'doc-1',
  entityId: 'carrier-1',
  expirationDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
  documentType: { label: 'MC Authority' },
};

const EXPIRING_INSURANCE = {
  id: 'ins-1',
  carrierId: 'carrier-1',
  coverageType: 'CARGO',
  expirationDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
};

function buildService(
  opts: {
    docs?: Record<string, unknown>[];
    insurance?: Record<string, unknown>[];
    alreadyNotified?: boolean;
  } = {},
) {
  const tx = {
    document: { findMany: jest.fn().mockResolvedValue(opts.docs ?? []) },
    carrierInsurance: { findMany: jest.fn().mockResolvedValue(opts.insurance ?? []) },
    carrier: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'carrier-1',
        legalName: 'Acme Trucking',
        assignmentEligible: true,
      }),
    },
    notification: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.alreadyNotified ? { id: 'existing-notif' } : null),
    },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };

  const service = new ComplianceExpirationNotificationService(
    prisma as never,
    audit as never,
    notifications as never,
  );
  return { service, tx, audit, notifications, prisma };
}

describe('ComplianceExpirationNotificationService — Workflow 3 §3.10', () => {
  it('notifies Operations Manager/Compliance Reviewer for a document expiring within a threshold window', async () => {
    const { service, notifications, audit } = buildService({ docs: [EXPIRING_DOC] });

    await service.run();

    expect(notifications.createForRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      ['OPERATIONS_MANAGER', 'COMPLIANCE_REVIEWER'],
      expect.objectContaining({ relatedEntityType: 'Document', relatedEntityId: 'doc-1' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Expiration Notification Sent' }),
    );
  });

  it('notifies for an insurance record expiring within a threshold window', async () => {
    const { service, notifications } = buildService({ insurance: [EXPIRING_INSURANCE] });

    await service.run();

    expect(notifications.createForRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      ['OPERATIONS_MANAGER', 'COMPLIANCE_REVIEWER'],
      expect.objectContaining({ relatedEntityType: 'CarrierInsurance', relatedEntityId: 'ins-1' }),
    );
  });

  it('"each fires once" — skips an item that already has a Notification for this threshold', async () => {
    const { service, notifications } = buildService({
      docs: [EXPIRING_DOC],
      alreadyNotified: true,
    });

    await service.run();

    expect(notifications.createForRoles).not.toHaveBeenCalled();
  });
});

describe('ComplianceExpirationNotificationService — Monitoring Phase 4A-2 (per-record error isolation)', () => {
  it('a failing document notification does not abort the rest of that org or subsequent orgs, and logs org+entity correlation', async () => {
    const docFail = { ...EXPIRING_DOC, id: 'doc-fail' };
    const docOk = { ...EXPIRING_DOC, id: 'doc-ok' };
    const docOrg2 = { ...EXPIRING_DOC, id: 'doc-org2' };

    const tx = {
      document: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: { organizationId: string } }) =>
            Promise.resolve(where.organizationId === ORG_ID ? [docFail, docOk] : [docOrg2]),
          ),
      },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([]) },
      carrier: {
        findFirst: jest.fn().mockResolvedValue({ id: 'carrier-1', legalName: 'Acme Trucking', assignmentEligible: true }),
      },
      notification: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { relatedEntityId: string } }) => {
          if (where.relatedEntityId === 'doc-fail') throw new Error('simulated DB failure');
          return Promise.resolve(null);
        }),
      },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }, { id: OTHER_ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(notifications.createForRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      expect.anything(),
      expect.objectContaining({ relatedEntityId: 'doc-ok' }),
    );
    expect(notifications.createForRoles).toHaveBeenCalledWith(
      expect.anything(),
      OTHER_ORG_ID,
      expect.anything(),
      expect.objectContaining({ relatedEntityId: 'doc-org2' }),
    );

    const failureLog = errorSpy.mock.calls.find((c) => String(c[0]).includes('doc-fail'));
    expect(failureLog).toBeDefined();
    expect(failureLog![0]).toContain(ORG_ID);
    expect(failureLog![0]).toContain('doc-fail');

    errorSpy.mockRestore();
  });
});

describe('ComplianceExpirationNotificationService — Monitoring Phase 4A-10 (run summary)', () => {
  it('a zero-record run reports orgsScanned but zero for every other counter, via Logger.log', async () => {
    const { service } = buildService({});
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    expect(logSpy).toHaveBeenCalledWith(
      'Compliance expiration notification sweep summary: orgsScanned=1 recordsMatched=0 recordsSucceeded=0 recordsFailed=0',
    );
    logSpy.mockRestore();
  });

  it('aggregates recordsMatched across all 3 thresholds and both record types without resetting between thresholds', async () => {
    // The mock's document/insurance findMany ignores the where-clause window
    // (as the real query would apply per-threshold), so this one doc + one
    // insurance record is returned on each of the 3 threshold iterations —
    // exactly mirroring a real record whose expiration falls inside all 3
    // windows. recordsMatched must reflect the sum across all 3 calls, not
    // just the last one.
    const { service } = buildService({ docs: [EXPIRING_DOC], insurance: [EXPIRING_INSURANCE] });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    // 1 doc + 1 insurance record, each counted once per threshold (3) = 6.
    expect(message).toContain('recordsMatched=6');
    expect(message).toContain('recordsSucceeded=6');
    expect(message).toContain('recordsFailed=0');
    logSpy.mockRestore();
  });

  it('an intentional in-transaction no-op (alreadySent dedup) still counts as recordsSucceeded, not recordsFailed', async () => {
    const { service } = buildService({ docs: [EXPIRING_DOC], alreadyNotified: true });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    expect(message).toContain('recordsMatched=3');
    expect(message).toContain('recordsSucceeded=3');
    expect(message).toContain('recordsFailed=0');
    logSpy.mockRestore();
  });

  it('an intentional in-transaction no-op (orphaned carrier — !carrier) still counts as recordsSucceeded', async () => {
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([EXPIRING_DOC]) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([]) },
      carrier: { findFirst: jest.fn().mockResolvedValue(null) },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    expect(notifications.createForRoles).not.toHaveBeenCalled();
    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    expect(message).toContain('recordsSucceeded=3');
    expect(message).toContain('recordsFailed=0');
    logSpy.mockRestore();
  });

  it('a mixed success/failure run across multiple orgs reports exact aggregated counts and escalates to Logger.warn', async () => {
    const docFail = { ...EXPIRING_DOC, id: 'doc-fail' };
    const docOk = { ...EXPIRING_DOC, id: 'doc-ok' };
    const docOrg2 = { ...EXPIRING_DOC, id: 'doc-org2' };

    const tx = {
      document: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: { organizationId: string } }) =>
            Promise.resolve(where.organizationId === ORG_ID ? [docFail, docOk] : [docOrg2]),
          ),
      },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([]) },
      carrier: {
        findFirst: jest.fn().mockResolvedValue({ id: 'carrier-1', legalName: 'Acme Trucking', assignmentEligible: true }),
      },
      notification: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { relatedEntityId: string } }) => {
          if (where.relatedEntityId === 'doc-fail') throw new Error('simulated DB failure');
          return Promise.resolve(null);
        }),
      },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }, { id: OTHER_ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    // docFail fails on all 3 thresholds (3 failures), docOk + docOrg2
    // succeed on all 3 thresholds each (6 successes) = 9 matched, 6
    // succeeded, 3 failed.
    expect(warnSpy).toHaveBeenCalledWith(
      'Compliance expiration notification sweep summary: orgsScanned=2 recordsMatched=9 recordsSucceeded=6 recordsFailed=3',
    );
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('security/PII — the summary log contains only aggregate counts, never entity ids, carrier names, or PII', async () => {
    const { service } = buildService({ docs: [EXPIRING_DOC] });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.run();

    const [message] = logSpy.mock.calls.find((c) => String(c[0]).includes('sweep summary'))!;
    expect(message).not.toContain('doc-1');
    expect(message).not.toContain('Acme');
    expect(message).toMatch(
      /^Compliance expiration notification sweep summary: orgsScanned=\d+ recordsMatched=\d+ recordsSucceeded=\d+ recordsFailed=\d+$/,
    );
    logSpy.mockRestore();
  });
});

describe('ComplianceExpirationNotificationService — Monitoring Phase 4A-17 (sanitized error logging)', () => {
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

  it('the loadExpiringDocs (candidate-query) failure log contains only org+threshold correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([]) },
      carrier: { findFirst: jest.fn() },
      notification: { findFirst: jest.fn() },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      `Compliance expiration notification sweep: failed to load expiring documents for org ${ORG_ID}, threshold 30d. errorType=Error`,
    );
  });

  it('SECURITY — the loadExpiringDocs failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([]) },
      carrier: { findFirst: jest.fn() },
      notification: { findFirst: jest.fn() },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('the per-document failure log contains only org+entity+threshold correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([{ ...EXPIRING_DOC, id: 'doc-fail' }]) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([]) },
      carrier: { findFirst: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    expect(errorSpy).toHaveBeenCalledWith(
      `Compliance expiration notification sweep: failed for org ${ORG_ID}, document doc-fail, threshold 30d. errorType=Error`,
    );
  });

  it('SECURITY — the per-document failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([{ ...EXPIRING_DOC, id: 'doc-fail' }]) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([]) },
      carrier: { findFirst: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('the loadExpiringInsurance (candidate-query) failure log contains only org+threshold correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([]) },
      carrierInsurance: { findMany: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      carrier: { findFirst: jest.fn() },
      notification: { findFirst: jest.fn() },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await expect(service.run()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      `Compliance expiration notification sweep: failed to load expiring insurance for org ${ORG_ID}, threshold 30d. errorType=Error`,
    );
  });

  it('SECURITY — the loadExpiringInsurance failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([]) },
      carrierInsurance: { findMany: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      carrier: { findFirst: jest.fn() },
      notification: { findFirst: jest.fn() },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('the per-insurance-record failure log contains only org+entity+threshold correlation and errorType — no raw error content', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([]) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([{ ...EXPIRING_INSURANCE, id: 'ins-fail' }]) },
      carrier: { findFirst: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    expect(errorSpy).toHaveBeenCalledWith(
      `Compliance expiration notification sweep: failed for org ${ORG_ID}, carrierInsurance ins-fail, threshold 30d. errorType=Error`,
    );
  });

  it('SECURITY — the per-insurance-record failure log never contains a sensitive marker present in error.message/.stack/.meta', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const tx = {
      document: { findMany: jest.fn().mockResolvedValue([]) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue([{ ...EXPIRING_INSURANCE, id: 'ins-fail' }]) },
      carrier: { findFirst: jest.fn().mockRejectedValue(sensitivePrismaError()) },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };
    const service = new ComplianceExpirationNotificationService(prisma as never, audit as never, notifications as never);

    await service.run();

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });
});
