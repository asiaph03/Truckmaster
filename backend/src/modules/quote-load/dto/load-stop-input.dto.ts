import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';
import { StopType } from '@prisma/client';

/**
 * DATABASE_DESIGN.md §9 — richer than QuoteStop (full street address,
 * optional saved-location reference, optional appointment/contact
 * detail). Address fields are always populated inline even when
 * `customerLocationId` is set — a snapshot at time of booking, not a
 * live join.
 */
export class LoadStopInputDto {
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsEnum(StopType)
  stopType!: StopType;

  @IsOptional()
  @IsUUID()
  customerLocationId?: string;

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
