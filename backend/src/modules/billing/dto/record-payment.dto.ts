import { IsDateString, IsOptional, IsString, Matches, MinLength } from 'class-validator';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** Workflow 8 §8.9 — Record Payment. */
export class RecordPaymentDto {
  @Matches(DECIMAL_RE, { message: 'amount must be a decimal string, e.g. "500.00"' })
  amount!: string;

  @IsDateString()
  paymentDate!: string;

  @IsString()
  @MinLength(1)
  method!: string;

  @IsOptional()
  @IsString()
  referenceNumber?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
