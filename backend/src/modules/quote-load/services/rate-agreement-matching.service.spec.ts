import { Prisma } from '@prisma/client';
import { RateAgreementMatchingService } from './rate-agreement-matching.service';

/** Workflow 4 §4.4 — Rate Agreement matching (lane + equipment, active only). */
describe('RateAgreementMatchingService.findMatch', () => {
  const ORG_ID = 'org-1';
  const CUSTOMER_ID = 'customer-1';

  function buildTx(agreements: unknown[]) {
    return { customerRateAgreement: { findMany: jest.fn().mockResolvedValue(agreements) } };
  }

  const service = new RateAgreementMatchingService();

  it('returns the matching agreement when lane and equipment match', async () => {
    const tx = buildTx([
      {
        id: 'agreement-1',
        originCity: 'Dallas',
        originState: 'TX',
        destinationCity: 'Chicago',
        destinationState: 'IL',
        rate: new Prisma.Decimal('2450.00'),
      },
    ]);

    const result = await service.findMatch(
      tx as never,
      ORG_ID,
      CUSTOMER_ID,
      'Dallas',
      'TX',
      'Chicago',
      'IL',
      'DRY_VAN',
    );

    expect(result).toEqual({
      rateAgreementId: 'agreement-1',
      suggestedRate: new Prisma.Decimal('2450.00'),
    });
  });

  it('matches case/punctuation-insensitively', async () => {
    const tx = buildTx([
      {
        id: 'agreement-1',
        originCity: 'DALLAS',
        originState: 'tx',
        destinationCity: 'Chicago ',
        destinationState: 'IL',
        rate: new Prisma.Decimal('2450.00'),
      },
    ]);

    const result = await service.findMatch(
      tx as never,
      ORG_ID,
      CUSTOMER_ID,
      'dallas',
      'TX',
      'chicago',
      'il',
      'DRY_VAN',
    );

    expect(result?.rateAgreementId).toBe('agreement-1');
  });

  it('returns null when no agreement matches the lane', async () => {
    const tx = buildTx([
      {
        id: 'agreement-1',
        originCity: 'Dallas',
        originState: 'TX',
        destinationCity: 'Chicago',
        destinationState: 'IL',
        rate: new Prisma.Decimal('2450.00'),
      },
    ]);

    const result = await service.findMatch(
      tx as never,
      ORG_ID,
      CUSTOMER_ID,
      'Houston',
      'TX',
      'Chicago',
      'IL',
      'DRY_VAN',
    );

    expect(result).toBeNull();
  });

  it('returns null when the candidate list is empty (e.g. expired/future-dated agreements already filtered by the query)', async () => {
    const tx = buildTx([]);

    const result = await service.findMatch(
      tx as never,
      ORG_ID,
      CUSTOMER_ID,
      'Dallas',
      'TX',
      'Chicago',
      'IL',
      'DRY_VAN',
    );

    expect(result).toBeNull();
  });

  it('queries only active agreements (effectiveDate <= today, expirationDate null or >= today) for this customer/org/equipment', async () => {
    const tx = buildTx([]);

    await service.findMatch(
      tx as never,
      ORG_ID,
      CUSTOMER_ID,
      'Dallas',
      'TX',
      'Chicago',
      'IL',
      'REEFER',
    );

    const whereArg = (tx.customerRateAgreement.findMany as jest.Mock).mock.calls[0][0].where;
    expect(whereArg.organizationId).toBe(ORG_ID);
    expect(whereArg.customerId).toBe(CUSTOMER_ID);
    expect(whereArg.equipmentType).toBe('REEFER');
    expect(whereArg.effectiveDate.lte).toBeInstanceOf(Date);
    expect(whereArg.OR).toEqual([
      { expirationDate: null },
      { expirationDate: { gte: expect.any(Date) } },
    ]);
  });
});
