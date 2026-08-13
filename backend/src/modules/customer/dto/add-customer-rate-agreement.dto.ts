import { IsDateString, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { EquipmentType } from '@prisma/client';

/** Money fields are decimal strings ("2450.00"), never JSON numbers (§5.3). */
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

export class AddCustomerRateAgreementDto {
  @IsString()
  @MinLength(1)
  originCity!: string;

  @IsString()
  @MinLength(2)
  originState!: string;

  @IsString()
  @MinLength(1)
  destinationCity!: string;

  @IsString()
  @MinLength(2)
  destinationState!: string;

  @IsEnum(EquipmentType)
  equipmentType!: EquipmentType;

  @Matches(DECIMAL_RE, { message: 'rate must be a decimal string, e.g. "2450.00"' })
  rate!: string;

  @IsString()
  @MinLength(1)
  rateType!: string;

  @IsDateString()
  effectiveDate!: string;

  @IsOptional()
  @IsDateString()
  expirationDate?: string;

  @IsOptional()
  @IsString()
  fuelSurchargeRules?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
