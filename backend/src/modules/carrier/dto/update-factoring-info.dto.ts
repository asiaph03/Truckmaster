import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateFactoringInfoDto {
  @IsBoolean()
  usesFactoring!: boolean;

  @IsOptional()
  @IsString()
  factoringCompany?: string;

  @IsOptional()
  @IsString()
  remitToAddress?: string;

  @IsOptional()
  @IsString()
  factoringContact?: string;

  @IsOptional()
  @IsString()
  paymentInstructions?: string;

  @IsOptional()
  @IsString()
  noaStatus?: string;

  @IsOptional()
  @IsUUID()
  noaDocumentId?: string;
}
