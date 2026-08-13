import { Injectable } from '@nestjs/common';
import { ActorType, Prisma } from '@prisma/client';
import { RequestContextStore } from '../tenant-context/request-context';

export interface RecordEventInput {
  organizationId: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason?: string;
  actorUserId?: string | null;
  actorType?: ActorType;
}

/**
 * The single write path for the universal AuditLog + DomainEvent backbone
 * (TECHNICAL_ARCHITECTURE.md §9, DATABASE_DESIGN.md §23–24). Every
 * service-layer mutation calls `record()` — never an ad hoc
 * `prisma.auditLog.create()` — so the AuditLog/DomainEvent pair is always
 * written together, transactionally, with the actor/correlation ID
 * resolved consistently in one place (§9.2/§9.3).
 *
 * MUST be called with the same transaction handle (`tx`) as the business
 * mutation it's describing — this is what makes "the audit entry is
 * atomic with the change it describes" (§4.10) actually true, rather than
 * a two-step write that could partially fail.
 */
@Injectable()
export class AuditService {
  async record(tx: Prisma.TransactionClient, input: RecordEventInput): Promise<void> {
    const actorType = input.actorType ?? 'HUMAN';

    // Falls back to the request context's userId when the caller doesn't
    // explicitly pass one — the common case for human-triggered actions.
    // Callers performing a genuinely system-triggered action (no request
    // in flight, e.g. a future scheduled sweep) pass actorType: 'SYSTEM'
    // and actorUserId: null explicitly instead of relying on this fallback.
    let actorUserId = input.actorUserId;
    if (actorUserId === undefined && actorType === 'HUMAN') {
      try {
        actorUserId = RequestContextStore.current().userId ?? null;
      } catch {
        actorUserId = null;
      }
    }

    let correlationId: string | undefined;
    try {
      correlationId = RequestContextStore.current().requestId;
    } catch {
      correlationId = undefined;
    }

    const previousValue = (input.previousValue ?? undefined) as Prisma.InputJsonValue | undefined;
    const newValue = (input.newValue ?? undefined) as Prisma.InputJsonValue | undefined;

    await tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: actorUserId ?? null,
        actorType,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        previousValue,
        newValue,
        reason: input.reason,
        correlationId,
      },
    });

    await tx.domainEvent.create({
      data: {
        organizationId: input.organizationId,
        eventType: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: (newValue ?? previousValue ?? {}) as Prisma.InputJsonValue,
        actorUserId: actorUserId ?? null,
        actorType,
        correlationId,
      },
    });
  }
}
