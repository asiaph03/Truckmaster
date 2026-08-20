import { IsDateString, IsOptional } from 'class-validator';

/** Workflow 9 §9.6 step 2 — "enters/confirms payment date," defaults to now. */
export class MarkPaidDto {
  @IsOptional()
  @IsDateString()
  paymentDate?: string;
}
