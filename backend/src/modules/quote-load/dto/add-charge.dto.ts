import { IsEnum, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { ChargeLineItemSide } from '@prisma/client';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Workflow 5/8/9's shared "Add Charge" action (Decision Log D9,
 * DATABASE_DESIGN.md §14) — *using* an existing, already-defined charge
 * type (chargeTypeId), never defining a new one here (that's the
 * Admin-only B3 endpoint, `/charge-types`). Always `source = ADJUSTMENT`
 * — the two `source = ORIGINAL` linehaul rows are system-created only
 * (at booking and at carrier assignment), never through this endpoint.
 */
export class AddChargeDto {
  @IsEnum(ChargeLineItemSide)
  side!: ChargeLineItemSide;

  @IsUUID()
  chargeTypeId!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Matches(DECIMAL_RE, { message: 'quantity must be a decimal string, e.g. "1.00"' })
  quantity?: string;

  @Matches(DECIMAL_RE, { message: 'unitRate must be a decimal string, e.g. "150.00"' })
  unitRate!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
