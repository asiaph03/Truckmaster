import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    for (const org of orgs) {
      await this.prisma.withTenantTransaction(org.id, async (tx) => {
        const stale = await tx.organizationMembership.findMany({
          where: {
            organizationId: org.id,
            status: 'INVITED',
            invitationExpiresAt: { lt: new Date() },
          },
        });

        for (const membership of stale) {
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
        }
      });
    }
  }
}
