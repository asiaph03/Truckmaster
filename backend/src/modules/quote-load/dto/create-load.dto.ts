import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EquipmentType } from '@prisma/client';
import { LoadStopInputDto } from './load-stop-input.dto';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Direct-to-Booked creation, Workflow 4 §4.8 required fields exactly.
 * Reference numbers are optional here and addable later via
 * UpdateLoadReferenceNumbersDto (§4.10) — never required to reach
 * BOOKED.
 */
export class CreateLoadDto {
  @IsUUID()
  customerId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LoadStopInputDto)
  stops!: LoadStopInputDto[];

  @IsEnum(EquipmentType)
  equipmentType!: EquipmentType;

  @Matches(DECIMAL_RE, { message: 'customerRate must be a decimal string, e.g. "2450.00"' })
  customerRate!: string;

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

  /**
   * Workflow 4 §4.3 — required (true) when the Customer is Inactive, to
   * proceed past the booking-path override gate. Ignored/unnecessary for
   * Active customers; Prospect/Blocked customers can never be overridden.
   */
  @IsOptional()
  @IsBoolean()
  confirmInactiveCustomerOverride?: boolean;
}
