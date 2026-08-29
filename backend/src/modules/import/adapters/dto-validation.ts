import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * Bulk Import — reuses the same class-validator machinery the global
 * ValidationPipe runs on every manual-entry request (approved
 * architecture, Decision 1/2), applied directly to a row's mapped values
 * instead of an HTTP body.
 */
export async function validateRowDto<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<{ dto?: T; errors: string[] }> {
  const instance = plainToInstance(cls, plain);
  const violations = await validate(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  if (violations.length > 0) {
    const errors = violations.flatMap((v) => Object.values(v.constraints ?? {}));
    return { errors };
  }
  return { dto: instance, errors: [] };
}

/** Empty-string mapped cells become `undefined` so `@IsOptional()` fields behave correctly instead of failing string-length checks. */
export function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}
