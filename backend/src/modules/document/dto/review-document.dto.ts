import { IsIn, IsString, MinLength, ValidateIf } from 'class-validator';

export class ReviewDocumentDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  /** Required when decision === 'REJECTED' (Workflow 3 §3.4). */
  @ValidateIf((dto: ReviewDocumentDto) => dto.decision === 'REJECTED')
  @IsString()
  @MinLength(1)
  rejectionReason?: string;
}
