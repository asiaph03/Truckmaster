import { validate } from 'class-validator';
import { IsPositiveDecimalString } from './positive-decimal.decorator';

class TestDto {
  @IsPositiveDecimalString()
  amount!: string;
}

async function isValidAmount(amount: unknown): Promise<boolean> {
  const dto = new TestDto();
  dto.amount = amount as string;
  const errors = await validate(dto);
  return errors.length === 0;
}

describe('IsPositiveDecimalString — post-Phase-8 remediation (Priority 3)', () => {
  it('accepts a well-formed positive decimal string', async () => {
    expect(await isValidAmount('150.00')).toBe(true);
    expect(await isValidAmount('1')).toBe(true);
    expect(await isValidAmount('0.01')).toBe(true);
  });

  it('rejects zero', async () => {
    expect(await isValidAmount('0')).toBe(false);
    expect(await isValidAmount('0.00')).toBe(false);
    expect(await isValidAmount('0.0')).toBe(false);
  });

  it('rejects negative values', async () => {
    expect(await isValidAmount('-50.00')).toBe(false);
    expect(await isValidAmount('-1')).toBe(false);
  });

  it('rejects malformed input', async () => {
    expect(await isValidAmount('abc')).toBe(false);
    expect(await isValidAmount('150.000')).toBe(false);
    expect(await isValidAmount('')).toBe(false);
    expect(await isValidAmount(150)).toBe(false);
  });
});
