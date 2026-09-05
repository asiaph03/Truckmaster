import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CancelLoadDto } from './cancel-load.dto';

/** Cancel Load workflow — the cancellation reason is required, never blank. */
describe('CancelLoadDto', () => {
  it('rejects a missing reason', async () => {
    const dto = plainToInstance(CancelLoadDto, {});
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('rejects an empty-string reason', async () => {
    const dto = plainToInstance(CancelLoadDto, { reason: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('accepts a non-empty reason', async () => {
    const dto = plainToInstance(CancelLoadDto, { reason: 'Customer cancelled the order.' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
