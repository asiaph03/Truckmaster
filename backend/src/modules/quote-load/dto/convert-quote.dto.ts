import { IsBoolean, IsOptional, Matches } from 'class-validator';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Workflow 4 §4.7 step 3 — "Explicitly confirms the customer rate...
 * Validates a rate confirmation action has occurred (cannot proceed
 * silently)." Always required in the request, even when the confirmed
 * value equals the original quoted rate — that's what distinguishes an
 * explicit confirmation from a silent carry-forward.
 */
export class ConvertQuoteDto {
  @Matches(DECIMAL_RE, {
    message: 'confirmedCustomerRate must be a decimal string, e.g. "2450.00"',
  })
  confirmedCustomerRate!: string;

  /** Workflow 4 §4.3 — re-run at conversion time; required if the Customer became/remained Inactive. */
  @IsOptional()
  @IsBoolean()
  confirmInactiveCustomerOverride?: boolean;
}
