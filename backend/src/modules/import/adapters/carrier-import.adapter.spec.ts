import { CarrierImportAdapter } from './carrier-import.adapter';

describe('CarrierImportAdapter', () => {
  function buildAdapter(existingCarrier: unknown = null) {
    const carrierService = {
      create: jest.fn().mockResolvedValue({ id: 'new-carrier-1' }),
    };
    const tx = { carrier: { findFirst: jest.fn().mockResolvedValue(existingCarrier) } };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const adapter = new CarrierImportAdapter(carrierService as never, prisma as never);
    return { adapter, carrierService, tx };
  }

  const VALID_DTO = {
    legalName: 'Acme Trucking',
    mcNumber: 'MC123',
    dotNumber: 'DOT456',
    addressLine1: '1 Main St',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    primaryContactName: 'Jane',
    primaryContactPhone: '555-1234',
    primaryContactEmail: 'jane@acme.com',
  };

  it('mapRow rejects a row missing MC/DOT number', async () => {
    const { adapter } = buildAdapter();
    const result = await adapter.mapRow({ ...VALID_DTO, mcNumber: '', dotNumber: '' });
    expect(result.dto).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('checkBusinessRules is a hard block with no override when MC/DOT already exists — errors, not a warning', async () => {
    const { adapter } = buildAdapter({ id: 'existing-1', legalName: 'Acme Trucking' });
    const result = await adapter.checkBusinessRules('org-1', VALID_DTO);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('already exists');
    expect(result.duplicateWarning).toBeUndefined();
  });

  it('checkBusinessRules passes when no MC/DOT collision exists', async () => {
    const { adapter } = buildAdapter(null);
    const result = await adapter.checkBusinessRules('org-1', VALID_DTO);
    expect(result.errors).toHaveLength(0);
  });

  it('commit calls the real CarrierService.create — never a second implementation', async () => {
    const { adapter, carrierService } = buildAdapter();
    const result = await adapter.commit('org-1', VALID_DTO, 'user-1');
    expect(carrierService.create).toHaveBeenCalledWith('org-1', VALID_DTO, 'user-1');
    expect(result.entityId).toBe('new-carrier-1');
  });
});
