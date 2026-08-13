import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { EquipmentType } from '@prisma/client';

export class AddTrailerDto {
  @IsString()
  @MinLength(1)
  unitNumber!: string;

  @IsEnum(EquipmentType)
  trailerType!: EquipmentType;

  @IsOptional()
  @IsString()
  vin?: string;

  @IsOptional()
  @IsString()
  plate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
