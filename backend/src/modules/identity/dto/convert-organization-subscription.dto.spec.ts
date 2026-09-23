import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConvertOrganizationSubscriptionDto } from './convert-organization-subscription.dto';

/** Phase 4 — locked limit-validation rules: null = unlimited, 0 is valid, negative/non-integer rejected. */
describe('ConvertOrganizationSubscriptionDto', () => {
  function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(ConvertOrganizationSubscriptionDto, body);
    return validate(dto);
  }

  it('accepts null for both fields (unlimited)', async () => {
    const errors = await errorsFor({ maxCarriers: null, maxDrivers: null });
    expect(errors).toHaveLength(0);
  });

  it('accepts 0 for both fields — a valid, explicit "no new resources" value', async () => {
    const errors = await errorsFor({ maxCarriers: 0, maxDrivers: 0 });
    expect(errors).toHaveLength(0);
  });

  it('accepts a positive integer for both fields', async () => {
    const errors = await errorsFor({ maxCarriers: 5, maxDrivers: 20 });
    expect(errors).toHaveLength(0);
  });

  it('rejects a negative maxCarriers', async () => {
    const errors = await errorsFor({ maxCarriers: -1, maxDrivers: 5 });
    expect(errors.some((e) => e.property === 'maxCarriers')).toBe(true);
  });

  it('rejects a negative maxDrivers', async () => {
    const errors = await errorsFor({ maxCarriers: 5, maxDrivers: -1 });
    expect(errors.some((e) => e.property === 'maxDrivers')).toBe(true);
  });

  it('rejects a non-integer maxCarriers', async () => {
    const errors = await errorsFor({ maxCarriers: 2.5, maxDrivers: 5 });
    expect(errors.some((e) => e.property === 'maxCarriers')).toBe(true);
  });

  it('rejects a non-integer maxDrivers', async () => {
    const errors = await errorsFor({ maxCarriers: 5, maxDrivers: 2.5 });
    expect(errors.some((e) => e.property === 'maxDrivers')).toBe(true);
  });

  it('rejects a missing (undefined) maxCarriers — both fields are required', async () => {
    const errors = await errorsFor({ maxDrivers: 5 });
    expect(errors.some((e) => e.property === 'maxCarriers')).toBe(true);
  });

  it('rejects a missing (undefined) maxDrivers — both fields are required', async () => {
    const errors = await errorsFor({ maxCarriers: 5 });
    expect(errors.some((e) => e.property === 'maxDrivers')).toBe(true);
  });
});
