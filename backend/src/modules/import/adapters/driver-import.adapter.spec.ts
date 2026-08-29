import { DriverImportAdapter } from './driver-import.adapter';

describe('DriverImportAdapter', () => {
  function buildAdapter() {
    const carrierService = { addDriver: jest.fn().mockResolvedValue({ id: 'driver-1' }) };
    const adapter = new DriverImportAdapter(carrierService as never);
    return { adapter, carrierService };
  }

  it('declares a required parentField resolving against Carrier by legal name', () => {
    const { adapter } = buildAdapter();
    expect(adapter.parentEntity).toBe('CARRIER');
    expect(adapter.parentField?.required).toBe(true);
  });

  it('mapRow rejects a row missing a required field', async () => {
    const { adapter } = buildAdapter();
    const result = await adapter.mapRow({ firstName: '', lastName: 'Doe', phone: '555-1234' });
    expect(result.dto).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('commit delegates to the real CarrierService.addDriver with the resolved parentId', async () => {
    const { adapter, carrierService } = buildAdapter();
    const dto = { firstName: 'Jane', lastName: 'Doe', phone: '555-1234' };
    const result = await adapter.commit('org-1', dto, 'user-1', 'carrier-9');
    expect(carrierService.addDriver).toHaveBeenCalledWith('org-1', 'carrier-9', dto, 'user-1');
    expect(result.entityId).toBe('driver-1');
  });
});
