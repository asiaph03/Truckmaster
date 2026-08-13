import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { CustomerLocationType } from '@prisma/client';

export class AddCustomerLocationDto {
  @IsString()
  @MinLength(1)
  name!: string;

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

  @IsEnum(CustomerLocationType)
  locationType!: CustomerLocationType;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  operatingHours?: string;

  @IsOptional()
  @IsString()
  appointmentRequirements?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
