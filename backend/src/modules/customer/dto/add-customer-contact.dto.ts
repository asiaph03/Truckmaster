import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { CustomerContactRole } from '@prisma/client';

export class AddCustomerContactDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEnum(CustomerContactRole)
  role!: CustomerContactRole;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
