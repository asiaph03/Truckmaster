import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateCarrierDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  legalName?: string;

  @IsOptional()
  @IsString()
  dba?: string;

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
  @MinLength(1)
  primaryContactName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  primaryContactPhone?: string;

  @IsOptional()
  @IsEmail()
  primaryContactEmail?: string;
}
