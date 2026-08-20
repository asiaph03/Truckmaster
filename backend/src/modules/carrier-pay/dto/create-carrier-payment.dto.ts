import { CarrierPaymentType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** Workflow 9 §9.2 — method/reference/notes optional at Draft stage. */
export class CreateCarrierPaymentDto {
  @IsEnum(CarrierPaymentType)
  paymentType!: CarrierPaymentType;

  @Matches(DECIMAL_RE, { message: 'amount must be a decimal string, e.g. "500.00"' })
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
