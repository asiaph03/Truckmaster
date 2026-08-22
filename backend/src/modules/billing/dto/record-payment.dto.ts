import { IsDateString, IsOptional, IsString, MinLength } from 'class-validator';
import { IsPositiveDecimalString } from '../../../common/validation/positive-decimal.decorator';

/** Workflow 8 §8.9 — Record Payment. Amount must be > 0 (post-Phase-8 remediation, Priority 3). */
export class RecordPaymentDto {
  @IsPositiveDecimalString()
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
