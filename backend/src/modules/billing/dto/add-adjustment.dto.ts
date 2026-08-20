import { AdjustmentType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** Workflow 8 §8.11 — reason is required, non-empty. */
export class AddAdjustmentDto {
  @IsEnum(AdjustmentType)
  type!: AdjustmentType;

  @Matches(DECIMAL_RE, { message: 'amount must be a decimal string, e.g. "150.00"' })
  amount!: string;

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsOptional()
  @IsDateString()
  adjustmentDate?: string;
}
