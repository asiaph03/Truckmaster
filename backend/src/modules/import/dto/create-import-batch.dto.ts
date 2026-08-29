import { IsEnum, IsIn, IsString, MinLength } from 'class-validator';
import { ImportEntityType } from '@prisma/client';

/**
 * `fileName`/`fileFormat` live here rather than on a separate
 * confirm-upload step (disclosed deviation from the approved endpoint
 * shapes — see ImportBatchService's doc comment): StorageService's
 * presigned upload URL must be generated with a fixed Content-Type at
 * creation time, so the file's format must be known before that point.
 */
export class CreateImportBatchDto {
  @IsEnum(ImportEntityType)
  entityType!: ImportEntityType;

  @IsString()
  @MinLength(1)
  fileName!: string;

  @IsIn(['CSV', 'XLSX'])
  fileFormat!: 'CSV' | 'XLSX';
}
