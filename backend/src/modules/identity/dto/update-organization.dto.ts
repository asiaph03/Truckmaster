import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { PaymentTerms } from '@prisma/client';

/**
 * Frontend Phase 14 (Organization Settings) — every field optional for
 * partial updates. Mirrors CreateOrganizationDto's validators for the 9
 * fields it shares; `defaultPaymentTerms` is the one field Create never
 * accepted (schema-defaulted to NET_30 at provisioning), so it gets its
 * own new-but-minimal validator. `id`/`createdByUserId`/`createdAt`/
 * `status` are deliberately never declared here — the global
 * ValidationPipe's `forbidNonWhitelisted: true` (configure-app.ts)
 * rejects any request that tries to set them.
 */
export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  city?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  state?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  zip?: string;

  @IsOptional()
  @IsString()
  country?: string;

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

  /**
   * Changing this affects future/default usage only (Workflow 2 §2.3 /
   * Workflow 1's own note) — it never retroactively rewrites
   * Customer.paymentTerms for existing customers. That behavior lives
   * entirely in CustomerService (customer creation reads the org's
   * current default at the moment of creation only) and is unmodified
   * by this DTO/endpoint.
   */
  @IsOptional()
  @IsEnum(PaymentTerms)
  defaultPaymentTerms?: PaymentTerms;
}
