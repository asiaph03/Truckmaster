import { IsArray, IsIn, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Mirrors ExtractedCustomer (rate-confirmation-extractor.interface.ts)
 * field-for-field — this is the same object already round-tripped
 * through CreateCustomerModal, just echoed back once more so it can be
 * durably snapshotted.
 */
class ExtractedCustomerDto {
  @IsString()
  extractedName!: string;

  @IsOptional() @IsString() billingAddressLine1?: string | null;
  @IsOptional() @IsString() billingCity?: string | null;
  @IsOptional() @IsString() billingState?: string | null;
  @IsOptional() @IsString() billingZip?: string | null;
  @IsOptional() @IsString() primaryContactName?: string | null;
  @IsOptional() @IsString() primaryContactEmail?: string | null;
  @IsOptional() @IsString() primaryContactPhone?: string | null;
}

/** Mirrors ExtractedStop field-for-field. */
class ExtractedStopDto {
  @IsIn(['PICKUP', 'DELIVERY'])
  stopType!: 'PICKUP' | 'DELIVERY';

  @IsOptional() @IsString() companyName?: string | null;
  @IsOptional() @IsString() addressLine1?: string | null;
  @IsOptional() @IsString() city?: string | null;
  @IsOptional() @IsString() state?: string | null;
  @IsOptional() @IsString() zip?: string | null;
  @IsOptional() @IsString() contactName?: string | null;
  @IsOptional() @IsString() contactPhone?: string | null;
  @IsOptional() @IsString() appointmentDatetime?: string | null;
}

class UnmappedFieldDto {
  @IsString()
  label!: string;

  @IsString()
  value!: string;
}

/** Mirrors ExtractedRateConfirmationData field-for-field — see that interface's own doc comment for the canonical shape. */
class ExtractedRateConfirmationDataDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ExtractedCustomerDto)
  customer?: ExtractedCustomerDto | null;

  @IsOptional()
  @IsIn(['DRY_VAN', 'REEFER', 'FLATBED'])
  equipmentType?: 'DRY_VAN' | 'REEFER' | 'FLATBED' | null;

  @IsOptional() @IsString() customerRate?: string | null;
  @IsOptional() @IsString() customerPoNumber?: string | null;
  @IsOptional() @IsString() bolNumber?: string | null;
  @IsOptional() @IsString() pickupNumber?: string | null;
  @IsOptional() @IsString() customerReferenceNumber?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExtractedStopDto)
  stops!: ExtractedStopDto[];

  @IsArray()
  @IsString({ each: true })
  warnings!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UnmappedFieldDto)
  unmappedFields!: UnmappedFieldDto[];
}

/**
 * Rate Confirmation → New Load auto-populate feature — Load Draft
 * creation. `extractionId` resolves (server-side, see
 * LoadDraftService.create) to the SAME Document the original upload
 * already created — never a new upload. `extractedData` is the
 * already-computed extraction result the frontend has in hand from that
 * same session; it is snapshotted verbatim, never re-derived by calling
 * the extractor again.
 */
export class CreateLoadDraftDto {
  @IsUUID()
  extractionId!: string;

  @IsUUID()
  customerId!: string;

  @ValidateNested()
  @Type(() => ExtractedRateConfirmationDataDto)
  extractedData!: ExtractedRateConfirmationDataDto;
}
