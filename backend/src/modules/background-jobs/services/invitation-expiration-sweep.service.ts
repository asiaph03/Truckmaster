import { Injectable, Logger } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';

/** Task #9 — same shape as the other sweeps' ADMIN_VISIBILITY_ROLES. */
const ADMIN_VISIBILITY_ROLES: MembershipRoleName[] = ['ADMIN'];

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

    for (const org of orgs) {
      let stale: Awaited<ReturnType<typeof this.loadStaleMemberships>>;
      try {
        stale = await this.loadStaleMemberships(org.id);
      } catch (error) {
        this.logger.error(
          `Invitation expiration sweep: failed to load candidates for org ${org.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
        continue;
      }

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
        } catch (error) {
          this.logger.error(
            `Invitation expiration sweep: failed for org ${org.id}, membership ${membership.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }
  }
}
