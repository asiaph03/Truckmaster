import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';

/**
 * Workflow 4 §4.5 — unlike the invitation-expiration case, no lazy
 * check exists anywhere for Quotes today: an `OPEN` Quote past its
 * `expirationDate` currently sits there forever with no code path
 * transitioning it. This sweep is the first implementation of §4.5's
 * automatic `OPEN → LOST` rule, not just proactive housekeeping.
 */
@Injectable()
export class QuoteExpirationSweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    for (const org of orgs) {
      await this.prisma.withTenantTransaction(org.id, async (tx) => {
        const stale = await tx.quote.findMany({
          where: {
            organizationId: org.id,
            status: 'OPEN',
            expirationDate: { lt: new Date() },
          },
        });

        for (const quote of stale) {
          await tx.quote.update({
            where: { id: quote.id },
            data: { status: 'LOST', lossReason: 'Expired' },
          });

          await this.audit.record(tx, {
            organizationId: org.id,
            action: 'Quote Expired — Automatically Marked Lost',
            entityType: 'Quote',
            entityId: quote.id,
            actorType: 'SYSTEM',
          });
        }
      });
    }
  }
}
