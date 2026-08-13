import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MinLength,
} from 'class-validator';
import { InsuranceCoverageType } from '@prisma/client';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** Workflow 3 §3.6 — the COI document must already exist (uploaded separately). */
export class AddCarrierInsuranceDto {
  @IsEnum(InsuranceCoverageType)
  coverageType!: InsuranceCoverageType;

  @Matches(DECIMAL_RE, { message: 'coverageAmount must be a decimal string, e.g. "1000000.00"' })
  coverageAmount!: string;

  @IsString()
  @MinLength(1)
  insuranceCompany!: string;

  @IsOptional()
  @IsString()
  agentContact?: string;

  @IsDateString()
  effectiveDate!: string;

  @IsDateString()
  expirationDate!: string;

  @IsUUID()
  coiDocumentId!: string;
}
