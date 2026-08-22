import { CarrierPaymentType } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { IsPositiveDecimalString } from '../../../common/validation/positive-decimal.decorator';

/** Workflow 9 §9.2 — method/reference/notes optional at Draft stage; amount must be > 0 (post-Phase-8 remediation, Priority 3). */
export class CreateCarrierPaymentDto {
  @IsEnum(CarrierPaymentType)
  paymentType!: CarrierPaymentType;

  @IsPositiveDecimalString()
  amount!: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  referenceNumber?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
