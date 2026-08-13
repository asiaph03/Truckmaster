import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { CarrierContactRole } from '@prisma/client';

export class AddCarrierContactDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEnum(CarrierContactRole)
  role!: CarrierContactRole;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
