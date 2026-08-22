import { AdjustmentType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { IsPositiveDecimalString } from '../../../common/validation/positive-decimal.decorator';

/** Workflow 8 §8.11 — reason is required, non-empty; amount must be > 0 (post-Phase-8 remediation, Priority 3). */
export class AddAdjustmentDto {
  @IsEnum(AdjustmentType)
  type!: AdjustmentType;

  @IsPositiveDecimalString()
  amount!: string;

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsOptional()
  @IsDateString()
  adjustmentDate?: string;
}
