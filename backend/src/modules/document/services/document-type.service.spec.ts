import { DocumentTypeService } from './document-type.service';

const ORG_ID = 'org-1';

function buildService() {
  const tx = {
    documentTypeDefinition: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'dt-1', code: 'W9', category: 'CARRIER_COMPLIANCE', organizationId: null },
        { id: 'dt-2', code: 'POD', category: 'LOAD', organizationId: null },
      ]),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const service = new DocumentTypeService(prisma as never);
  return { service, tx };
}

describe('DocumentTypeService.list', () => {
  it('queries both org-owned and system-default (null-org) types', async () => {
    const { service, tx } = buildService();

    await service.list(ORG_ID);

    expect(tx.documentTypeDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ organizationId: ORG_ID }, { organizationId: null }] },
        orderBy: { label: 'asc' },
      }),
    );
  });

  it('adds a category filter when provided', async () => {
    const { service, tx } = buildService();

    await service.list(ORG_ID, 'CARRIER_COMPLIANCE');

    expect(tx.documentTypeDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ organizationId: ORG_ID }, { organizationId: null }],
          category: 'CARRIER_COMPLIANCE',
        },
      }),
    );
  });

  it('returns the rows resolved by the transaction', async () => {
    const { service } = buildService();

    const result = await service.list(ORG_ID);

    expect(result).toHaveLength(2);
  });
});
