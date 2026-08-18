import { Inject, Injectable } from '@nestjs/common';
import { MembershipRoleName, OrganizationMembership, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { TokenService } from './token.service';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { EMAIL_SENDER, IEmailSender } from '../../../common/email/email-sender.interface';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  PermissionError,
} from '../../../common/errors/app-error';

const INVITATION_EXPIRY_DAYS = 7;

@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly tokenService: TokenService,
    private readonly passwordService: PasswordService,
    private readonly audit: AuditService,
    @Inject(EMAIL_SENDER) private readonly emailSender: IEmailSender,
  ) {}

  // ---------------------------------------------------------------------
  // Role resolution / authorization helpers, shared by guards + services
  // ---------------------------------------------------------------------

  async getRoles(organizationId: string, userId: string): Promise<MembershipRoleName[]> {
    return this.prisma.withUserTransaction(userId, async (tx) => {
      const membership = await tx.organizationMembership.findFirst({
        where: { organizationId, userId, status: 'ACTIVE' },
        include: { roles: true },
      });
      return membership?.roles.map((r) => r.role) ?? [];
    });
  }

  async listActiveMemberships(userId: string) {
    return this.prisma.withUserTransaction(userId, (tx) =>
      tx.organizationMembership.findMany({
        where: { userId, status: 'ACTIVE' },
        include: { organization: true },
      }),
    );
  }

  async listMemberships(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.organizationMembership.findMany({
        where: { organizationId },
        include: { user: true, roles: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Workflow 1 §1.4 — Invitation
  // ---------------------------------------------------------------------

  async invite(
    organizationId: string,
    dto: InviteMemberDto,
    actingUserId: string,
  ): Promise<OrganizationMembership> {
    await this.assertHasRole(organizationId, actingUserId, 'ADMIN');

    let user = await this.userService.findByEmail(dto.email);

    const { raw: rawToken, hash: tokenHash } = this.tokenService.generate();
    const invitationExpiresAt = new Date();
    invitationExpiresAt.setDate(invitationExpiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    const membership = await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      if (user) {
        const existingMembership = await tx.organizationMembership.findUnique({
          where: { organizationId_userId: { organizationId, userId: user.id } },
        });
        if (existingMembership && existingMembership.status === 'ACTIVE') {
          throw new ConflictError(
            'This email already belongs to an active user in this organization.',
          );
        }
        if (
          existingMembership &&
          (existingMembership.status === 'INVITED' ||
            existingMembership.status === 'PENDING_VERIFICATION')
        ) {
          throw new ConflictError(
            'This email already has a pending invitation to this organization. Resend it instead of creating a new one.',
          );
        }
      }

      // Decision 1's "mechanics" note: reuse an existing global identity
      // if one exists for this email (no new password, no re-verification
      // needed) — this is the one case where reuse IS explicitly locked,
      // unlike the org-creation case (see OrganizationService).
      if (!user) {
        user = await this.userService.create({ email: dto.email, name: dto.email }, tx);
      }

      const created = await tx.organizationMembership.create({
        data: {
          organizationId,
          userId: user.id,
          // An existing, already-verified identity does not need
          // PENDING_VERIFICATION — that status is reserved for a brand-new
          // User's first-ever membership (DATABASE_DESIGN.md §2). It still
          // requires an explicit accept (status = INVITED), consistent
          // with never silently activating someone into a new org.
          status: 'INVITED',
          invitedByUserId: actingUserId,
          invitedAt: new Date(),
          invitationTokenHash: tokenHash,
          invitationExpiresAt,
        },
      });

      for (const role of dto.roles) {
        await tx.membershipRole.create({
          data: { organizationId, membershipId: created.id, role },
        });
      }

      await this.audit.record(tx, {
        organizationId,
        action: 'User Invited',
        entityType: 'OrganizationMembership',
        entityId: created.id,
        newValue: { email: dto.email, roles: dto.roles },
        actorUserId: actingUserId,
      });

      return created;
    });

    await this.emailSender.send({
      to: dto.email,
      subject: "You've been invited to join Truck Master TMS",
      body: `You've been invited to join an organization on Truck Master TMS. Accept: /accept-invitation?token=${rawToken}\nThis link expires in ${INVITATION_EXPIRY_DAYS} days.`,
    });

    return membership;
  }

  // ---------------------------------------------------------------------
  // Workflow 1 §1.6 — Resend / Cancel
  // ---------------------------------------------------------------------

  async resend(organizationId: string, membershipId: string, actingUserId: string) {
    await this.assertHasRole(organizationId, actingUserId, 'ADMIN');

    const { raw: rawToken, hash: tokenHash } = this.tokenService.generate();
    const invitationExpiresAt = new Date();
    invitationExpiresAt.setDate(invitationExpiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    const { updated, recipientEmail } = await this.prisma.withTenantTransaction(
      organizationId,
      async (tx) => {
        const membership = await this.expireIfNeeded(
          tx,
          organizationId,
          await this.requireMembershipTx(tx, organizationId, membershipId),
        );

        if (membership.status !== 'INVITED' && membership.status !== 'EXPIRED') {
          throw new BusinessRuleError('Only a pending or expired invitation can be resent.');
        }

        const result = await tx.organizationMembership.update({
          where: { id: membershipId },
          data: { status: 'INVITED', invitationTokenHash: tokenHash, invitationExpiresAt },
        });
        await this.audit.record(tx, {
          organizationId,
          action: 'Invitation Resent',
          entityType: 'OrganizationMembership',
          entityId: membershipId,
          actorUserId: actingUserId,
        });

        const user = await this.userService.findById(membership.userId);
        return { updated: result, recipientEmail: user?.email };
      },
    );

    if (recipientEmail) {
      await this.emailSender.send({
        to: recipientEmail,
        subject: "You've been invited to join Truck Master TMS",
        body: `Accept: /accept-invitation?token=${rawToken}\nThis link expires in ${INVITATION_EXPIRY_DAYS} days.`,
      });
    }

    return updated;
  }

  async cancel(organizationId: string, membershipId: string, actingUserId: string) {
    await this.assertHasRole(organizationId, actingUserId, 'ADMIN');

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const membership = await this.expireIfNeeded(
        tx,
        organizationId,
        await this.requireMembershipTx(tx, organizationId, membershipId),
      );

      if (membership.status !== 'INVITED' && membership.status !== 'EXPIRED') {
        throw new BusinessRuleError('Only a pending or expired invitation can be cancelled.');
      }

      const result = await tx.organizationMembership.update({
        where: { id: membershipId },
        data: { status: 'CANCELLED', invitationTokenHash: null },
      });
      await this.audit.record(tx, {
        organizationId,
        action: 'Invitation Cancelled',
        entityType: 'OrganizationMembership',
        entityId: membershipId,
        actorUserId: actingUserId,
      });
      return result;
    });
  }

  // ---------------------------------------------------------------------
  // Workflow 1 §1.3 / §1.5 — Activation (verification + invitation accept
  // are the same mechanical operation, per Decision 1's "mechanics" note)
  // ---------------------------------------------------------------------

  async activate(rawToken: string, password?: string): Promise<OrganizationMembership> {
    const tokenHash = this.tokenService.hash(rawToken);
    const found = await this.prisma.withInvitationTokenTransaction(tokenHash, (tx) =>
      tx.organizationMembership.findFirst({
        where: { invitationTokenHash: tokenHash },
      }),
    );

    if (!found) {
      throw new NotFoundError('Invalid or already-used invitation link.');
    }

    return this.prisma.withTenantTransaction(found.organizationId, async (tx) => {
      const membership = await this.expireIfNeeded(tx, found.organizationId, found);

      if (membership.status === 'EXPIRED') {
        throw new BusinessRuleError('This invitation has expired. Ask an Admin to resend it.');
      }
      if (membership.status === 'CANCELLED') {
        throw new BusinessRuleError('This invitation is no longer valid.');
      }
      if (membership.status === 'ACTIVE') {
        throw new BusinessRuleError('This invitation has already been used.');
      }
      if (membership.status !== 'INVITED' && membership.status !== 'PENDING_VERIFICATION') {
        throw new BusinessRuleError('This invitation cannot be activated.');
      }

      const user = await this.userService.findById(membership.userId);
      if (!user) throw new NotFoundError('User not found for this invitation.');

      const needsPassword = user.status === 'PENDING_VERIFICATION' && !user.passwordHash;
      if (needsPassword && !password) {
        throw new BusinessRuleError('A password is required to activate this account.');
      }

      if (needsPassword && password) {
        const hash = await this.passwordService.hash(password);
        await this.userService.setPasswordAndActivate(user.id, hash, tx);
      }

      const updated = await tx.organizationMembership.update({
        where: { id: membership.id },
        data: {
          status: 'ACTIVE',
          activatedAt: new Date(),
          invitationTokenHash: null,
        },
      });

      await this.audit.record(tx, {
        organizationId: membership.organizationId,
        action: needsPassword ? 'Admin Account Verified' : 'User Activated',
        entityType: 'OrganizationMembership',
        entityId: membership.id,
        actorUserId: user.id,
      });

      return updated;
    });
  }

  // ---------------------------------------------------------------------
  // Workflow 1 §1.7 — Deactivation, with zero-Admin protection
  // ---------------------------------------------------------------------

  async deactivate(organizationId: string, targetMembershipId: string, actingUserId: string) {
    await this.assertHasRole(organizationId, actingUserId, 'ADMIN');

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const target = await this.requireMembershipTx(tx, organizationId, targetMembershipId);

      if (target.status !== 'ACTIVE') {
        throw new BusinessRuleError('Only an active member can be deactivated.');
      }

      const targetRoles = await tx.membershipRole.findMany({ where: { membershipId: target.id } });
      const targetIsAdmin = targetRoles.some((r) => r.role === 'ADMIN');

      if (targetIsAdmin) {
        // Re-counted INSIDE this transaction (§4.5) — never trusted from
        // an earlier read, closing the race window between two
        // simultaneous deactivation requests.
        const otherActiveAdminCount = await tx.membershipRole.count({
          where: {
            organizationId,
            role: 'ADMIN',
            membership: { status: 'ACTIVE', id: { not: target.id } },
          },
        });

        if (otherActiveAdminCount === 0) {
          await this.audit.record(tx, {
            organizationId,
            action: 'User Deactivation Blocked — Last Active Admin',
            entityType: 'OrganizationMembership',
            entityId: target.id,
            actorUserId: actingUserId,
            actorType: 'SYSTEM',
          });
          const isSelf = target.userId === actingUserId;
          throw new BusinessRuleError(
            isSelf
              ? 'You cannot deactivate your own account because you are the only active Admin in your organization. Assign Admin to another user first.'
              : 'You cannot deactivate this user because they are the only active Admin in your organization. Assign Admin to another user first.',
          );
        }
      }

      const updated = await tx.organizationMembership.update({
        where: { id: target.id },
        data: { status: 'INACTIVE', deactivatedAt: new Date(), deactivatedByUserId: actingUserId },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'User Deactivated',
        entityType: 'OrganizationMembership',
        entityId: target.id,
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  async assertHasRole(
    organizationId: string,
    userId: string,
    role: MembershipRoleName,
  ): Promise<void> {
    const roles = await this.getRoles(organizationId, userId);
    if (!roles.includes(role)) {
      throw new PermissionError(`This action requires the ${role} role.`);
    }
  }

  private async requireMembershipTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
    membershipId: string,
  ) {
    const membership = await tx.organizationMembership.findFirst({
      where: { id: membershipId, organizationId },
    });
    if (!membership) throw new NotFoundError('Membership not found.');
    return membership;
  }

  /**
   * Workflow 1 §1.6: "(Automatic) When current date > invitation_expires_at
   * and status still Invited, System marks invitation Expired" — a real,
   * persisted, audited transition (`Invitation Expired`, system-generated),
   * not just an in-memory label.
   *
   * Implemented as a **just-in-time check-and-persist**, run inside the
   * same transaction as whatever operation touched this membership
   * (resend/cancel/activate above), rather than a proactive scheduled
   * sweep — that sweep (flipping every expired invitation org-wide on a
   * timer, without anyone touching them) is Phase 7 background-jobs scope
   * (TECHNICAL_ARCHITECTURE.md §15). This keeps the business rule fully
   * correct now (an expired invitation can never be used) while deferring
   * only the *proactive* housekeeping. See the Phase 1 report.
   */
  private async expireIfNeeded(
    tx: Prisma.TransactionClient,
    organizationId: string,
    membership: OrganizationMembership,
  ): Promise<OrganizationMembership> {
    if (
      membership.status === 'INVITED' &&
      membership.invitationExpiresAt &&
      membership.invitationExpiresAt < new Date()
    ) {
      const updated = await tx.organizationMembership.update({
        where: { id: membership.id },
        data: { status: 'EXPIRED' },
      });
      await this.audit.record(tx, {
        organizationId,
        action: 'Invitation Expired',
        entityType: 'OrganizationMembership',
        entityId: membership.id,
        actorType: 'SYSTEM',
      });
      return updated;
    }
    return membership;
  }
}
