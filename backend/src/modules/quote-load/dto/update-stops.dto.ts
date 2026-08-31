import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StopType } from '@prisma/client';

/**
 * Load Detail's Edit Stops action — corrects an existing Stop's
 * descriptive fields (never `customerLocationId`, which isn't exposed by
 * this form, and never the tracking fields `status`/`actualArrival`/
 * `actualDeparture`, which stay owned by `recordArrival`/`recordDeparture`).
 * `sequence` identifies which existing Stop this item targets — it is
 * never itself written to, so ordering is untouched by construction.
 *
 * Unlike `UpdateLoadReferenceNumbersDto`'s partial-patch semantics (an
 * absent field means "don't touch it"), this is a full-replace edit: the
 * form always submits every field's complete current state, so an absent/
 * empty optional field means "clear it" — enforced in
 * `DispatchTrackingService.updateStops`, not here.
 */
export class UpdateStopItemDto {
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsEnum(StopType)
  stopType!: StopType;

  @IsString()
  @MinLength(1)
  companyName!: string;

  @IsString()
  @MinLength(1)
  addressLine1!: string;

  @IsString()
  @MinLength(1)
  city!: string;

  @IsString()
  @MinLength(2)
  state!: string;

  @IsString()
  @MinLength(1)
  zip!: string;

  @IsOptional()
  @IsDateString()
  appointmentDatetime?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateStopsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpdateStopItemDto)
  stops!: UpdateStopItemDto[];
}
