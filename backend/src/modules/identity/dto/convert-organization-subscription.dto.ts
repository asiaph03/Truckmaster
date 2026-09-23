import { IsInt, Min, ValidateIf } from 'class-validator';

/**
 * Phase 4 — platform-admin TRIAL/EXPIRED → ACTIVE conversion. Deliberately
 * does NOT accept `subscriptionStatus` from the client (§10 of the locked
 * design — the endpoint itself always converts to ACTIVE; a caller can
 * never request CANCELLED/EXPIRED/another status through this DTO). Both
 * fields are required (no `@IsOptional()`) — conversion is one deliberate
 * action that always sets both limits, never a partial update.
 *
 * `null` = unlimited (existing Phase 2 semantics, unchanged). `0` is a
 * valid, explicit "no new qualifying resource may be created" value
 * (locked decision — not a separate status). `@ValidateIf` skips
 * `@IsInt`/`@Min(0)` only when the value is exactly `null`, so `null` is
 * accepted, `undefined` (an omitted field) still fails validation, and
 * any negative or non-integer number is rejected.
 */
export class ConvertOrganizationSubscriptionDto {
  @ValidateIf((_, value) => value !== null)
  @IsInt({ message: 'maxCarriers must be a whole number, or null for unlimited.' })
  @Min(0, { message: 'maxCarriers cannot be negative.' })
  maxCarriers!: number | null;

  @ValidateIf((_, value) => value !== null)
  @IsInt({ message: 'maxDrivers must be a whole number, or null for unlimited.' })
  @Min(0, { message: 'maxDrivers cannot be negative.' })
  maxDrivers!: number | null;
}
