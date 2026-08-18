import { IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { QuoteStopType } from '@prisma/client';

/** Workflow 4 §4.2 — lane-level only (city/state/zip), no full street address. */
export class QuoteStopInputDto {
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsEnum(QuoteStopType)
  stopType!: QuoteStopType;

  @IsString()
  @MinLength(1)
  addressCity!: string;

  @IsString()
  @MinLength(2)
  addressState!: string;

  @IsString()
  @MinLength(1)
  addressZip!: string;

  @IsOptional()
  @IsString()
  appointmentNotes?: string;
}
