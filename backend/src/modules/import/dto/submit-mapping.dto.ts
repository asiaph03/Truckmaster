import { IsObject } from 'class-validator';

export class SubmitMappingDto {
  /** sourceHeaderText -> targetFieldKey | null. Validated against the adapter's declared fields in the service layer. */
  @IsObject()
  columnMapping!: Record<string, string | null>;
}
