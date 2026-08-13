import { IsEnum, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';
import { CarrierServiceAreaType } from '@prisma/client';

/**
 * DATABASE_DESIGN.md §5 — application-layer validation (not a DB
 * constraint): a LANE row needs at least origin_state/destination_state;
 * a REGION row needs region_label.
 */
export class AddServiceAreaDto {
  @IsEnum(CarrierServiceAreaType)
  type!: CarrierServiceAreaType;

  @ValidateIf((dto: AddServiceAreaDto) => dto.type === 'LANE')
  @IsString()
  @MinLength(1)
  originCity?: string;

  @ValidateIf((dto: AddServiceAreaDto) => dto.type === 'LANE')
  @IsString()
  @MinLength(2)
  originState?: string;

  @ValidateIf((dto: AddServiceAreaDto) => dto.type === 'LANE')
  @IsString()
  @MinLength(1)
  destinationCity?: string;

  @ValidateIf((dto: AddServiceAreaDto) => dto.type === 'LANE')
  @IsString()
  @MinLength(2)
  destinationState?: string;

  @ValidateIf((dto: AddServiceAreaDto) => dto.type === 'REGION')
  @IsString()
  @MinLength(1)
  regionLabel?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
