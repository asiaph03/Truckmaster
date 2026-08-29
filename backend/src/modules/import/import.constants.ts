import { JobsOptions } from 'bullmq';
import { MembershipRoleName } from '@prisma/client';
import { ImportEntityType } from '@prisma/client';

/**
 * Bulk Import (PRD.md §1.4, §6.9, §10.1, §13). Approved technical design,
 * Decision 3 (file limits) — centralized so they can change later without
 * redesigning the workflow.
 */
export const IMPORT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;

export const IMPORT_COMMIT_QUEUE = 'IMPORT_COMMIT_QUEUE';
export const IMPORT_COMMIT_QUEUE_NAME = 'import-commit';

export interface ImportCommitJobData {
  importBatchId: string;
  organizationId: string;
}

/** Mirrors RATE_CONFIRMATION_JOB_OPTIONS's approved retry policy — transient/infra failures only (approved Decision 6/queue). */
export const IMPORT_COMMIT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};

/** Same role set as CustomerController's EDIT_ROLES — no new permission key (approved Decision 10). */
export const CUSTOMER_IMPORT_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'SALES_BOOKING',
  'ACCOUNTING',
];

/** Same role set as CarrierController's CREATE_EDIT_ROLES — no new permission key (approved Decision 10). */
export const CARRIER_IMPORT_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
];

/** Union — the coarse Guard-level gate on POST /import-batches; the fine-grained per-entityType check happens in the service layer (mirrors Roles decorator's documented split). */
export const ANY_IMPORT_ROLES: MembershipRoleName[] = [
  ...new Set([...CUSTOMER_IMPORT_ROLES, ...CARRIER_IMPORT_ROLES]),
];

export function importRolesFor(entityType: ImportEntityType): MembershipRoleName[] {
  switch (entityType) {
    case 'CUSTOMER':
    case 'CUSTOMER_CONTACT':
    case 'CUSTOMER_LOCATION':
      return CUSTOMER_IMPORT_ROLES;
    case 'CARRIER':
    case 'CARRIER_CONTACT':
    case 'DRIVER':
    case 'TRUCK':
    case 'TRAILER':
      return CARRIER_IMPORT_ROLES;
  }
}
