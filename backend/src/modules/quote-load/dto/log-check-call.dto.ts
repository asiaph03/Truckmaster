import { IsDateString, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { CheckCallOnTimeStatus } from '@prisma/client';

/** Workflow 6 §6.7 — occurredAt optional, defaulting to now (matching the arrival/departure timestamp convention). */
export class LogCheckCallDto {
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsString()
  @MinLength(1)
  contactMethod!: string;

  @IsString()
  @MinLength(1)
  personContacted!: string;

  @IsOptional()
  @IsString()
  locationCity?: string;

  @IsOptional()
  @IsString()
  locationState?: string;

  @IsOptional()
  @IsString()
  locationZip?: string;

  @IsOptional()
  @IsDateString()
  eta?: string;

  @IsEnum(CheckCallOnTimeStatus)
  onTimeStatus!: CheckCallOnTimeStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
