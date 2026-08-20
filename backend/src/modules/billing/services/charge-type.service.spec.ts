import { ChargeTypeService } from './charge-type.service';
import { NotFoundError } from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

function buildService(opts: { existing?: Record<string, unknown> | null } = {}) {
  const tx = {
    chargeTypeDefinition: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'ct-1', code: 'LINEHAUL', label: 'Linehaul', organizationId: null },
        ]),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'existing' in opts
            ? opts.existing
            : { id: 'ct-2', organizationId: ORG_ID, label: 'Old Label' },
        ),
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'ct-new', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'ct-2', ...data })),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new ChargeTypeService(prisma as never, audit as never);
  return { service, tx, audit };
}

describe('ChargeTypeService — Decision Log B3', () => {
  it('lists both system-default and org-owned types', async () => {
    const { service } = buildService();
    const types = await service.list(ORG_ID);
    expect(types).toHaveLength(1);
  });

  it('creates an org-owned custom type, never a system default', async () => {
    const { service, tx, audit } = buildService();

    const created = await service.create(
      ORG_ID,
      { code: 'CUSTOM_FEE', label: 'Custom Fee' },
      USER_ID,
    );

    expect(created.organizationId).toBe(ORG_ID);
    expect(created.isSystemDefault).toBe(false);
    expect(tx.chargeTypeDefinition.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Charge Type Created' }),
    );
  });

  it('updates only the label of an org-owned type', async () => {
    const { service, tx, audit } = buildService();

    const updated = await service.update(ORG_ID, 'ct-2', { label: 'New Label' }, USER_ID);

    expect(updated.label).toBe('New Label');
    expect(tx.chargeTypeDefinition.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { label: 'New Label' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Charge Type Updated' }),
    );
  });

  it('throws NotFoundError updating a type not owned by this org (including system defaults)', async () => {
    const { service } = buildService({ existing: null });

    await expect(service.update(ORG_ID, 'ct-system', { label: 'Hacked' }, USER_ID)).rejects.toThrow(
      NotFoundError,
    );
  });
});
