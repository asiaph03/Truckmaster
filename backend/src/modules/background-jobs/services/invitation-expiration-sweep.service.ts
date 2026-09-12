import { Injectable, Logger } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';

/** Task #9 — same shape as the other sweeps' ADMIN_VISIBILITY_ROLES. */
const ADMIN_VISIBILITY_ROLES: MembershipRoleName[] = ['ADMIN'];

/**
 * Monitoring Phase 4A-17 — a class-name-only error identifier, never
 * error.message/.stack. Safe by construction: a JS/TS class name is
 * developer-defined source text, never runtime/user-controlled content.
 * Every catch in this sweep can only ever receive a Prisma-sourced or
 * local-application error (see Phase 4A-17 audit) — this is a
 * defense-in-depth measure, not a response to a confirmed leak.
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Workflow 1 §1.6 — the proactive, org-wide counterpart to
 * `MembershipService.expireIfNeeded`'s lazy, just-in-time check (which
 * already keeps the business rule correct for any invitation someone
 * actually touches). This sweep is the "nobody touched it" case that
 * comment explicitly deferred to Phase 7 — same transition, same audit
 * action name (`Invitation Expired`), just triggered by a timer instead of
 * a request.
 */
@Injectable()
export class InvitationExpirationSweepService {
  private readonly logger = new Logger(InvitationExpirationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async loadStaleMemberships(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.organizationMembership.findMany({
        where: {
          organizationId,
          status: 'INVITED',
          invitationExpiresAt: { lt: new Date() },
        },
      }),
    );
  }

  /**
   * Monitoring Phase 4A-2 — each organization, and each record within an
   * organization, is isolated in its own `withTenantTransaction` call so a
   * single bad record (or a transient DB/notification error on it) can
   * never abort the rest of that organization's records or any
   * organization later in `orgs`. A shared per-org transaction couldn't
   * give this guarantee: Postgres aborts an ENTIRE transaction after any
   * statement error, so a JS-level try/catch around one record inside a
   * transaction shared with other records would still poison every
   * later statement in that same transaction.
   */
  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    // Monitoring Phase 4A-10 — local to this run() invocation only (never
    // an instance field), so each execution has its own isolated counters.
    // Safe by construction: all 6 sweeps share one BullMQ worker at
    // concurrency 1, so no two run() calls (this sweep or any other) ever
    // execute concurrently.
    let orgsScanned = 0;
    let recordsMatched = 0;
    let recordsSucceeded = 0;
    let recordsFailed = 0;

    for (const org of orgs) {
      orgsScanned++;

      let stale: Awaited<ReturnType<typeof this.loadStaleMemberships>>;
      try {
        stale = await this.loadStaleMemberships(org.id);
      } catch (error) {
        this.logger.error(
          `Invitation expiration sweep: failed to load candidates for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      recordsMatched += stale.length;

      for (const membership of stale) {
        try {
          await this.prisma.withTenantTransaction(org.id, async (tx) => {
            await tx.organizationMembership.update({
              where: { id: membership.id },
              data: { status: 'EXPIRED' },
            });

            await this.audit.record(tx, {
              organizationId: org.id,
              action: 'Invitation Expired',
              entityType: 'OrganizationMembership',
              entityId: membership.id,
              actorType: 'SYSTEM',
            });

            // invitedByUserId is nullable — silent-skip when absent, same
            // "no fallback broadcast" convention as every other sweep here.
            if (membership.invitedByUserId) {
              const existingNotification = await tx.notification.findFirst({
                where: {
                  organizationId: org.id,
                  type: 'INVITATION_EXPIRED',
                  relatedEntityType: 'OrganizationMembership',
                  relatedEntityId: membership.id,
                },
              });
              if (!existingNotification) {
                await this.notifications.createForUserAndRoles(
                  tx,
                  org.id,
                  membership.invitedByUserId,
                  ADMIN_VISIBILITY_ROLES,
                  {
                    type: 'INVITATION_EXPIRED',
                    message: 'An invitation you sent has expired.',
                    relatedEntityType: 'OrganizationMembership',
                    relatedEntityId: membership.id,
                  },
                );
              }
            }
          });
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `Invitation expiration sweep: failed for org ${org.id}, membership ${membership.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary = `Invitation expiration sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
    if (recordsFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
  }
}
