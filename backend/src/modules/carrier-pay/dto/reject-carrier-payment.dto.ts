import { IsString, MinLength } from 'class-validator';

/** Workflow 9 §9.4 — rejection requires a non-empty reason. */
export class RejectCarrierPaymentDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
