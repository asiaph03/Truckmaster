import { ArrayMinSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';

/**
 * Workflow 8 §8.1/§8.3/§8.4 — one Load selected = individual invoice path,
 * two or more (all belonging to the same customer, validated in the
 * service) = consolidated. TECHNICAL_ARCHITECTURE.md §5.2's exact locked
 * request shape.
 */
export class CreateInvoiceDto {
  @IsUUID()
  customerId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  loadIds!: string[];

  /** Workflow 8 §8.2 — required once any selected Load has pod_status != COMPLETE. */
  @IsOptional()
  @IsBoolean()
  podWarningAcknowledged?: boolean;
}
