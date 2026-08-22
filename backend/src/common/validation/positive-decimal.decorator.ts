import { registerDecorator, ValidationOptions } from 'class-validator';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Post-Phase-8 remediation (Priority 3) — Workflow 8 §8.9/§8.11 and
 * Workflow 9 §9.2 all explicitly require `amount > 0`. The pre-existing
 * per-DTO `@Matches(/^\d+(\.\d{1,2})?$/)` pattern (duplicated identically
 * across `RecordPaymentDto`, `AddAdjustmentDto`, `CreateCarrierPaymentDto`)
 * already rejects negative values (no `-` in the character class) and
 * malformed input — it only ever failed to reject exactly zero
 * (`"0"`/`"0.00"`). This decorator keeps the same shape check and adds the
 * missing `> 0` condition, as one shared validator rather than three
 * independently-duplicated regexes.
 */
export function IsPositiveDecimalString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPositiveDecimalString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return false;
          return Number(value) > 0;
        },
        defaultMessage(): string {
          return `${propertyName} must be a positive decimal string greater than zero, e.g. "150.00"`;
        },
      },
    });
  };
}
