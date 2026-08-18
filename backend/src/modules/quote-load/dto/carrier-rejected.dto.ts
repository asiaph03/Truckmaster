import { IsString, MinLength } from 'class-validator';

/** Workflow 5 §5.6 — rejection reason is required, never blank. */
export class CarrierRejectedDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
