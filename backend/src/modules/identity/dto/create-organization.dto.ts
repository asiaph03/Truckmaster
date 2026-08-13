import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Workflow 1 §1.1 required fields exactly — no additional fields.
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
}
