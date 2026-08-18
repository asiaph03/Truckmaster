import { IsUUID, Matches } from 'class-validator';

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** Workflow 5 §5.4 — Required Fields: eligible carrier, carrier rate. */
export class AssignCarrierDto {
  @IsUUID()
  carrierId!: string;

  @Matches(DECIMAL_RE, { message: 'carrierRate must be a decimal string, e.g. "2450.00"' })
  carrierRate!: string;
}
