import { IsEnum, IsOptional, IsString } from 'class-validator';
import { RiskStatus } from '@prisma/client';

/** Workflow 6 §6.8 — reason required when status != NORMAL, checked in the service (not here) since it's conditional on another field's value. */
export class SetRiskStatusDto {
  @IsEnum(RiskStatus)
  riskStatus!: RiskStatus;

  @IsOptional()
  @IsString()
  riskReason?: string;
}
