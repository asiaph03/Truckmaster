import { IsString, MinLength } from 'class-validator';

/** Decision Log B3 — Admin-only. Org-scoped custom charge type. */
export class CreateChargeTypeDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  label!: string;
}
