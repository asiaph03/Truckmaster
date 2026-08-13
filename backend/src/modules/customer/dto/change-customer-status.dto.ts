import { IsEnum } from 'class-validator';
import { CustomerStatus } from '@prisma/client';

/**
 * Workflow 2 §2.4 — status progression is a separate action from
 * creation, available to authorized users at any point; no checklist is
 * defined in the locked workflow ("belongs to a future workflow"), so no
 * additional gating is implemented here beyond the permission check.
 */
export class ChangeCustomerStatusDto {
  @IsEnum(CustomerStatus)
  status!: CustomerStatus;
}
