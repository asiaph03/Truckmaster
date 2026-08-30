import { CarrierComplianceExpirationSweepService } from './carrier-compliance-expiration-sweep.service';

const ORG_ID = 'org-1';

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
