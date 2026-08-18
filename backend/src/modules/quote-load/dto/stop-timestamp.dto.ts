import { IsDateString, IsOptional } from 'class-validator';

/** Workflow 6 §6.4/§6.5 — arrival/departure, timestamp defaults to now. */
export class StopTimestampDto {
  @IsOptional()
  @IsDateString()
  timestamp?: string;
}
