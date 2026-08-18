import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/** Workflow 6 §6.9 — post-dispatch editing; every field optional, at least implicitly one expected. */
export class UpdateDispatchDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  driverName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  driverPhone?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  truckNumber?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  trailerNumber?: string;

  @IsOptional()
  @IsUUID()
  sourceDriverId?: string;

  @IsOptional()
  @IsUUID()
  sourceTruckId?: string;

  @IsOptional()
  @IsUUID()
  sourceTrailerId?: string;
}
