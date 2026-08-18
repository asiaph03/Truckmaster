import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Workflow 5 §5.5 — optional, cumulative sourcing-contact log. `ASSIGNED`
 * and `REJECTED_AFTER_ASSIGNMENT` are deliberately excluded from this
 * enum: those two outcomes are system-set only, as direct byproducts of
 * the Assign/Carrier-Rejected actions (§5.4/§5.6) — never a free-standing
 * manual log entry.
 *
 * §5.5's step 1 also mentions a free-text "notes" field, but neither its
 * own "Data Model" line nor DATABASE_DESIGN.md §10's CarrierSourcingAttempt
 * column list include a notes column — resolved by following the locked
 * schema (no notes field accepted here).
 */
export class LogSourcingAttemptDto {
  @IsUUID()
  carrierId!: string;

  @IsEnum(['DECLINED', 'NO_RESPONSE', 'QUOTED'])
  outcome!: 'DECLINED' | 'NO_RESPONSE' | 'QUOTED';

  @IsOptional()
  @Matches(DECIMAL_RE, { message: 'carrierRate must be a decimal string, e.g. "2450.00"' })
  carrierRate?: string;
}
