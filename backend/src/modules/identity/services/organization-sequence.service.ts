import { Injectable } from '@nestjs/common';
import { OrganizationSequenceType, Prisma } from '@prisma/client';

/**
 * Org-scoped numbering (DATABASE_DESIGN.md §3 OrganizationSequence,
 * TECHNICAL_ARCHITECTURE.md §4.5/§4.7). Not consumed by anything yet —
 * Load/Quote/Invoice don't exist until Phase 3/6 — but implemented and
 * tested now since OrganizationSequence is an explicit Phase 1 entity.
 *
 * `getNextNumber` MUST be called with a transaction handle from an
 * already-open transaction (typically via `PrismaService.withTenantTransaction`)
 * so the row lock and the caller's record insert are atomic together —
 * calling it with a bare (non-transactional) Prisma client would reopen
 * the exact race condition this method exists to close.
 */
@Injectable()
export class OrganizationSequenceService {
  async getNextNumber(
    tx: Prisma.TransactionClient,
    organizationId: string,
    sequenceType: OrganizationSequenceType,
  ): Promise<bigint> {
    // Ensure a row exists (first number ever requested for this org+type).
    await tx.organizationSequence.upsert({
      where: { organizationId_sequenceType: { organizationId, sequenceType } },
      create: { organizationId, sequenceType, currentValue: 0n },
      update: {},
    });

    // SELECT ... FOR UPDATE via Prisma's row-locking query builder, then
    // increment in the same transaction — the lock is held until the
    // transaction commits/rolls back, so two concurrent callers for the
    // same org+type serialize instead of racing to the same number.
    const [locked] = await tx.$queryRaw<{ current_value: bigint }[]>`
      SELECT current_value FROM organization_sequence
      WHERE organization_id = ${organizationId}::uuid AND sequence_type = ${sequenceType}::"OrganizationSequenceType"
      FOR UPDATE
    `;

    const next = locked.current_value + 1n;

    await tx.organizationSequence.update({
      where: { organizationId_sequenceType: { organizationId, sequenceType } },
      data: { currentValue: next },
    });

    return next;
  }

  /**
   * PRD-locked formats (DATABASE_DESIGN.md §3): LOAD-000456, QUOTE-000123,
   * INV-000001 — 6-digit zero-padded, org-scoped sequential, independent
   * of the underlying database ID. Not used by any caller yet in Phase 1.
   */
  format(sequenceType: OrganizationSequenceType, value: bigint): string {
    const prefix = { LOAD: 'LOAD', QUOTE: 'QUOTE', INVOICE: 'INV' }[sequenceType];
    return `${prefix}-${value.toString().padStart(6, '0')}`;
  }
}
