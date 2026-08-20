import { QuoteExpirationSweepService } from './quote-expiration-sweep.service';

const ORG_ID = 'org-1';

function buildService(quotes: Record<string, unknown>[] = []) {
  const tx = {
    quote: {
      findMany: jest.fn().mockResolvedValue(quotes),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'quote-1', ...data })),
    },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new QuoteExpirationSweepService(prisma as never, audit as never);
  return { service, tx, audit, prisma };
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
