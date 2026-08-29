import { ParentResolutionService } from './parent-resolution';

describe('ParentResolutionService', () => {
  function buildService(findManyResult: unknown[]) {
    const tx = {
      customer: { findMany: jest.fn().mockResolvedValue(findManyResult) },
      carrier: { findMany: jest.fn() },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    return { service: new ParentResolutionService(prisma as never), tx };
  }

  it('resolves a single exact case-insensitive legal-name match', async () => {
    const { service, tx } = buildService([{ id: 'cust-1' }]);
    const result = await service.resolveByLegalName('org-1', 'CUSTOMER', 'acme inc');
    expect(tx.customer.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', legalName: { equals: 'acme inc', mode: 'insensitive' } },
      select: { id: true },
    });
    expect(result).toEqual({ id: 'cust-1' });
  });

  it('returns an error for zero matches (Decision 4)', async () => {
    const { service } = buildService([]);
    const result = await service.resolveByLegalName('org-1', 'CUSTOMER', 'Ghost LLC');
    expect(result).toEqual({ error: expect.stringContaining('No customer found') });
  });

  it('returns an error for multiple matches (Decision 4 — no ambiguous resolution)', async () => {
    const { service } = buildService([{ id: 'a' }, { id: 'b' }]);
    const result = await service.resolveByLegalName('org-1', 'CUSTOMER', 'Acme Inc');
    expect(result).toEqual({ error: expect.stringContaining('2 customers found') });
  });

  it('returns an error for a blank legal name without querying the database', async () => {
    const { service, tx } = buildService([]);
    const result = await service.resolveByLegalName('org-1', 'CUSTOMER', '   ');
    expect(result).toEqual({ error: expect.stringContaining('required') });
    expect(tx.customer.findMany).not.toHaveBeenCalled();
  });
});
