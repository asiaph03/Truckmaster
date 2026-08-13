import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** Workflow 3 §3.1 required fields exactly. */
export class CreateCarrierDto {
  @IsString()
  @MinLength(1)
  legalName!: string;

  @IsOptional()
  @IsString()
  dba?: string;

  @IsString()
  @MinLength(1)
  mcNumber!: string;

  @IsString()
  @MinLength(1)
  dotNumber!: string;

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

  @IsString()
  @MinLength(1)
  primaryContactName!: string;

  @IsString()
  @MinLength(1)
  primaryContactPhone!: string;

  @IsEmail()
  primaryContactEmail!: string;
}
