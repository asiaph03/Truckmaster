import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/**
 * Workflow 6 §6.1 — Required Fields: driver name, driver phone, truck
 * number, trailer number, all four required. TECHNICAL_ARCHITECTURE.md
 * §5.2's own Request type marks `driverPhone` with a `?`, but the very
 * next line of that same section ("Validation: all four required fields
 * present") and Workflow 6 §6.1's explicit Required Fields list both treat
 * it as required — resolved by following the two explicit statements over
 * the apparent `?` typo in the third.
 */
export class DispatchLoadDto {
  @IsString()
  @MinLength(1)
  driverName!: string;

  @IsString()
  @MinLength(1)
  driverPhone!: string;

  @IsString()
  @MinLength(1)
  truckNumber!: string;

  @IsString()
  @MinLength(1)
  trailerNumber!: string;

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
