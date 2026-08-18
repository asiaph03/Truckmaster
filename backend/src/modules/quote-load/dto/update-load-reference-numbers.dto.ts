import { IsOptional, IsString } from 'class-validator';

/**
 * Workflow 4 §4.10 — addable/updatable at booking or any time after,
 * never required to reach BOOKED. All fields optional; only the ones
 * present in a given request are updated.
 */
export class UpdateLoadReferenceNumbersDto {
  @IsOptional()
  @IsString()
  customerPoNumber?: string;

  @IsOptional()
  @IsString()
  bolNumber?: string;

  @IsOptional()
  @IsString()
  pickupNumber?: string;

  @IsOptional()
  @IsString()
  customerReferenceNumber?: string;
}
