import { IsBoolean, IsOptional } from 'class-validator';

/** Workflow 5 §5.7 step 5 — sending via email is optional. */
export class GenerateRateConfirmationDto {
  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;
}
