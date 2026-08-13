import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { PaymentTerms } from '@prisma/client';

/**
 * Workflow 2 §2.5 — Customer master data remains editable at any time;
 * every field here is optional (partial update), each captured as a
 * field-level audit diff by the service layer.
 */
export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  billingAddressLine1?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  billingCity?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  billingState?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  billingZip?: string;

  @IsOptional()
  @IsString()
  billingCountry?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  primaryContactName?: string;

  @IsOptional()
  @IsEmail()
  primaryContactEmail?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  primaryContactPhone?: string;

  @IsOptional()
  @IsUUID()
  accountOwnerUserId?: string;

  @IsOptional()
  @IsEnum(PaymentTerms)
  paymentTerms?: PaymentTerms;
}
