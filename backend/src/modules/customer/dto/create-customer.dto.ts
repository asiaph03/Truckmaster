import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { PaymentTerms } from '@prisma/client';

/**
 * Workflow 2 §2.1 required fields exactly — no additional fields.
 */
export class CreateCustomerDto {
  @IsString()
  @MinLength(1)
  legalName!: string;

  @IsString()
  @MinLength(1)
  billingAddressLine1!: string;

  @IsString()
  @MinLength(1)
  billingCity!: string;

  @IsString()
  @MinLength(1)
  billingState!: string;

  @IsString()
  @MinLength(1)
  billingZip!: string;

  @IsOptional()
  @IsString()
  billingCountry?: string;

  @IsString()
  @MinLength(1)
  primaryContactName!: string;

  @IsEmail()
  primaryContactEmail!: string;

  @IsString()
  @MinLength(1)
  primaryContactPhone!: string;

  @IsOptional()
  @IsUUID()
  accountOwnerUserId?: string;

  /** Omit to inherit Organization.defaultPaymentTerms (Workflow 2 §2.1). */
  @IsOptional()
  @IsEnum(PaymentTerms)
  paymentTermsOverride?: PaymentTerms;

  /** §2.2 — set true to proceed past a shown duplicate warning. */
  @IsOptional()
  @IsBoolean()
  acknowledgeDuplicates?: boolean;
}
