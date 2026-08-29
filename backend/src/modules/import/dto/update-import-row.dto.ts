import { IsBoolean } from 'class-validator';

export class UpdateImportRowDto {
  @IsBoolean()
  acknowledgeDuplicate!: boolean;
}
