import { IsString, MinLength } from 'class-validator';

/** Decision Log B3 — Admin-only. Label only — `code` is a stable identifier used in lookups elsewhere. */
export class UpdateChargeTypeDto {
  @IsString()
  @MinLength(1)
  label!: string;
}
