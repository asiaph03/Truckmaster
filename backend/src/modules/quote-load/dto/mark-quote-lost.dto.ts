import { IsString, MinLength } from 'class-validator';

/** Workflow 4 §4.6 — reason is required, never blank. */
export class MarkQuoteLostDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
