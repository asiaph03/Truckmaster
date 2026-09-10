import { Injectable, Logger } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';

/** Task #9 — same shape as the other sweeps' ADMIN_VISIBILITY_ROLES. */
const ADMIN_VISIBILITY_ROLES: MembershipRoleName[] = ['ADMIN'];

/**
 * Workflow 4 §4.5 — unlike the invitation-expiration case, no lazy
 * check exists anywhere for Quotes today: an `OPEN` Quote past its
 * `expirationDate` currently sits there forever with no code path
 * transitioning it. This sweep is the first implementation of §4.5's
 * automatic `OPEN → LOST` rule, not just proactive housekeeping.
 */
@Injectable()
export class QuoteExpirationSweepService {
  private readonly logger = new Logger(QuoteExpirationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async loadStaleQuotes(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.quote.findMany({
        where: {
          organizationId,
          status: 'OPEN',
          expirationDate: { lt: new Date() },
        },
      }),
    );
  }

  /** Monitoring Phase 4A-2 — see InvitationExpirationSweepService.run() for why each org/record gets its own transaction. */
  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    for (const org of orgs) {
      let stale: Awaited<ReturnType<typeof this.loadStaleQuotes>>;
      try {
        stale = await this.loadStaleQuotes(org.id);
      } catch (error) {
        this.logger.error(
          `Quote expiration sweep: failed to load candidates for org ${org.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
        continue;
      }

      for (const quote of stale) {
        try {
          await this.prisma.withTenantTransaction(org.id, async (tx) => {
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

            const existingNotification = await tx.notification.findFirst({
              where: {
                organizationId: org.id,
                type: 'QUOTE_EXPIRED',
                relatedEntityType: 'Quote',
                relatedEntityId: quote.id,
              },
            });
            if (!existingNotification) {
              await this.notifications.createForUserAndRoles(
                tx,
                org.id,
                quote.createdByUserId,
                ADMIN_VISIBILITY_ROLES,
                {
                  type: 'QUOTE_EXPIRED',
                  message: `Quote expired — ${quote.quoteNumber}`,
                  relatedEntityType: 'Quote',
                  relatedEntityId: quote.id,
                },
              );
            }
          });
        } catch (error) {
          this.logger.error(
            `Quote expiration sweep: failed for org ${org.id}, quote ${quote.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }
  }
}
