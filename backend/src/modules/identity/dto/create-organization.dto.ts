import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Phase 5 — the only two ways an organization can be provisioned. Not a
 * Prisma-backed enum (no `isDemo`/provisioning-mode column exists or is
 * added — `subscriptionStatus: TRIAL` plus the trial timestamps remain the
 * sole source of truth once the organization exists); this is a
 * request-only discriminator consumed entirely inside
 * `OrganizationService.createOrganization()`.
 */
export enum ProvisioningMode {
  STANDARD = 'STANDARD',
  DEMO = 'DEMO',
}

/**
 * Workflow 1 §1.1 required fields exactly, plus Phase 5's optional
 * provisioning mode — no other additional fields. `provisioningMode` is
 * the only lever a caller has; the resulting subscription/trial values
 * (`subscriptionStatus`, `trialStartedAt`, `trialEndsAt`, `maxCarriers`,
 * `maxDrivers`) are always server-computed inside the service, never
 * accepted directly from the client.
 */
export class CreateOrganizationDto {
  @IsString()
  @MinLength(1)
  legalName!: string;

  @IsString()
  @MinLength(1)
  addressLine1!: string;

  @IsString()
  @MinLength(1)
  city!: string;

  @IsString()
  @MinLength(1)
  state!: string;

  @IsString()
  @MinLength(1)
  zip!: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsString()
  @MinLength(1)
  primaryContactName!: string;

  @IsEmail()
  primaryContactEmail!: string;

  @IsString()
  @MinLength(1)
  primaryContactPhone!: string;

  /** Omitted (or STANDARD) preserves the exact pre-Phase-5 behavior. */
  @IsOptional()
  @IsEnum(ProvisioningMode)
  provisioningMode?: ProvisioningMode;
}
