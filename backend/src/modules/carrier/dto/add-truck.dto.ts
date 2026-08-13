import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { EquipmentType } from '@prisma/client';

export class AddTruckDto {
  @IsString()
  @MinLength(1)
  unitNumber!: string;

  @IsEnum(EquipmentType)
  truckType!: EquipmentType;

  @IsOptional()
  @IsString()
  make?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number;

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
