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
