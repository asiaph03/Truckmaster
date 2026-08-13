import { IsDateString, IsOptional, IsString, MinLength } from 'class-validator';

export class AddFmcsaVerificationDto {
  @IsDateString()
  verificationDate!: string;

  @IsString()
  @MinLength(1)
  resultStatus!: string;

  @IsOptional()
  @IsString()
  authorityInfo?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
