import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EquipmentType } from '@prisma/client';
import { QuoteStopInputDto } from './quote-stop-input.dto';

/** Money fields are decimal strings ("2450.00"), never JSON numbers (§5.3). */
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Workflow 4 §4.2 required fields exactly. Pickup/delivery composition
 * (at least one of each) is a business rule, not a shape rule — checked
 * in QuoteService, not here.
 */
export class CreateQuoteDto {
  @IsUUID()
  customerId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuoteStopInputDto)
  stops!: QuoteStopInputDto[];

  @IsEnum(EquipmentType)
  equipmentType!: EquipmentType;

  @Matches(DECIMAL_RE, { message: 'customerRate must be a decimal string, e.g. "2450.00"' })
  customerRate!: string;

  /** Optional — defaults to now + 7 days (Workflow 4 §4.2 step 5). */
  @IsOptional()
  @IsDateString()
  expirationDate?: string;
}
