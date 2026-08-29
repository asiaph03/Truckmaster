import { ImportEntityType } from '@prisma/client';
import { CustomerDuplicateCandidate } from '../../customer/services/customer.service';

export interface ImportFieldSpec {
  key: string;
  label: string;
  required: boolean;
}

export interface MapRowResult<TDto> {
  dto?: TDto;
  errors: string[];
}

/**
 * Mutable, call-scoped cache. Only Customer uses `customerCandidates`
 * (approved technical design, Decision 9/12) — every other adapter
 * ignores it. Preloaded once per validation call / once per commit job,
 * then grown as rows are created within that same call/job so intra-batch
 * duplicates are still caught.
 */
export interface ImportDuplicateCache {
  customerCandidates?: CustomerDuplicateCandidate[];
}

export interface ImportBusinessRuleResult {
  errors: string[];
  duplicateWarning?: unknown[];
}

/**
 * One adapter per entity type (approved architecture, Decision 1/2) —
 * entity-specific behind one shared pipeline. Every adapter's `commit`
 * calls the real existing service method (CustomerService.create,
 * CarrierService.addDriver, etc.), which manages its own
 * `withTenantTransaction` internally exactly as manual entry does — this
 * is *how* "one transaction per imported row" (approved Decision 5) is
 * satisfied, not something the adapter layer re-implements. Parent-name
 * resolution (child adapters only) is a shared orchestration step run by
 * the caller, not part of this interface — see adapters/parent-resolution.ts.
 */
export interface ImportAdapter<TDto = Record<string, unknown>> {
  entityType: ImportEntityType;
  fields: ImportFieldSpec[];
  /** Only set for child entities — the column resolving the parent by exact legal-name match (approved Decision 4). */
  parentField?: ImportFieldSpec;
  parentEntity?: 'CUSTOMER' | 'CARRIER';

  mapRow(mapped: Record<string, string>): MapRowResult<TDto> | Promise<MapRowResult<TDto>>;

  /**
   * Runs both during synchronous validation (Preview) and, for Customer
   * only, is implicitly re-run inside `commit()` (via CustomerService's
   * own precomputed-candidate path) against the live, growing cache.
   * Every other adapter returns `{ errors: [] }` unconditionally except
   * Carrier, which checks the real hard MC/DOT duplicate here too so it
   * surfaces at Preview time, not only at commit.
   */
  checkBusinessRules(
    organizationId: string,
    dto: TDto,
    cache: ImportDuplicateCache,
  ): Promise<ImportBusinessRuleResult>;

  commit(
    organizationId: string,
    dto: TDto,
    actingUserId: string,
    parentId: string | undefined,
    acknowledgeDuplicate: boolean,
    cache: ImportDuplicateCache,
  ): Promise<{ entityId: string }>;
}
