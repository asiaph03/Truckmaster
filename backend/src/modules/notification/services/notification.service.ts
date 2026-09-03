import { Injectable } from '@nestjs/common';
import { MembershipRoleName, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundError } from '../../../common/errors/app-error';

export interface CreateNotificationInput {
  recipientUserId: string;
  type: NotificationType;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Phase 7 — the in-app notification store (DATABASE_DESIGN.md §25).
 * `create`/`createForRoles` are called directly by the background-job
 * services (Decision 6: plain synchronous service calls, not a pub/sub
 * event bus — matching every other cross-cutting service in this codebase,
 * e.g. CarrierEligibilityService/LoadPodStatusService). Each is run inside
 * the caller's already-open transaction, mirroring `AuditService.record`'s
 * own contract, so a notification is only ever persisted alongside the
 * business fact that triggered it.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tx: Prisma.TransactionClient,
    organizationId: string,
    input: CreateNotificationInput,
  ): Promise<void> {
    await tx.notification.create({
      data: {
        organizationId,
        recipientUserId: input.recipientUserId,
        type: input.type,
        message: input.message,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
      },
    });
  }

  /**
   * Workflow 3 §3.10 — compliance-expiring notifications go to a role
   * ("Operations Manager"/"Compliance"), not a single named user (Carrier
   * has no owner concept, unlike Customer.accountOwnerUserId). Fans out one
   * Notification row per Active membership holding any of `roles`.
   */
  async createForRoles(
    tx: Prisma.TransactionClient,
    organizationId: string,
    roles: MembershipRoleName[],
    input: Omit<CreateNotificationInput, 'recipientUserId'>,
  ): Promise<void> {
    const memberships = await tx.organizationMembership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        roles: { some: { role: { in: roles } } },
      },
      select: { userId: true },
    });

    for (const membership of memberships) {
      await this.create(tx, organizationId, { ...input, recipientUserId: membership.userId });
    }
  }

  async list(
    organizationId: string,
    recipientUserId: string,
    filters: { unreadOnly?: boolean; page?: number; pageSize?: number } = {},
  ) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const pageSize = Math.min(
      filters.pageSize && filters.pageSize > 0 ? filters.pageSize : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.notification.findMany({
        where: {
          organizationId,
          recipientUserId,
          ...(filters.unreadOnly ? { read: false } : {}),
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    );
  }

  /**
   * Operational Alerts feature — the notification-bell badge previously
   * derived its count from `.filter(n => !n.isRead)` over the same
   * page-size-10 list rendered in the dropdown, silently undercounting
   * once more than 10 notifications existed. This gives the frontend an
   * authoritative count without changing the list endpoint's pagination.
   */
  async countUnread(organizationId: string, recipientUserId: string): Promise<number> {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.notification.count({ where: { organizationId, recipientUserId, read: false } }),
    );
  }

  /** Self-scoped — a recipient may only mark their own notifications read, never another user's. */
  async markRead(organizationId: string, recipientUserId: string, id: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.notification.findFirst({
        where: { id, organizationId, recipientUserId },
      });
      if (!existing) throw new NotFoundError('Notification not found.');

      return tx.notification.update({ where: { id }, data: { read: true } });
    });
  }

  async markAllRead(organizationId: string, recipientUserId: string): Promise<{ count: number }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const result = await tx.notification.updateMany({
        where: { organizationId, recipientUserId, read: false },
        data: { read: true },
      });
      return { count: result.count };
    });
  }
}
