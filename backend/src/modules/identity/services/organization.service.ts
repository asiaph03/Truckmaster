import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { TokenService } from './token.service';
import { UserService } from './user.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { UpdateOrganizationDto } from '../dto/update-organization.dto';
import { PermissionError } from '../../../common/errors/app-error';
import {
  EMAIL_QUEUE,
  EmailJobData,
  EMAIL_JOB_OPTIONS,
} from '../../../common/email/email-queue.constants';

const INVITATION_EXPIRY_DAYS = 7;

/**
 * Frontend Phase 14 — the exact, explicitly-approved editable field set.
 * `id`/`createdByUserId`/`createdAt`/`status` are deliberately absent —
 * see OrganizationService.update's doc comment.
 */
const UPDATABLE_ORGANIZATION_FIELDS = [
  'legalName',
  'addressLine1',
  'city',
  'state',
  'zip',
  'country',
  'primaryContactName',
  'primaryContactEmail',
  'primaryContactPhone',
  'defaultPaymentTerms',
] as const satisfies readonly (keyof UpdateOrganizationDto)[];

/**
 * Workflow 1 §1.1 (Organization Creation) + §1.2 (Initial Admin Account
 * Creation) — implemented as one combined, transactional operation exactly
 * as the workflow specifies ("system-triggered immediately, same
 * transaction").
 *
 * Platform-console operation (ARCHITECTURE.md §1.1's two-tier structure) —
 * callable only by a User with `isPlatformSuperAdmin = true`. Runs with NO
 * organization context (the Super Admin has no membership, by design —
 * Decision 1's "Super Admin does not automatically receive access to an
 * organization's operational/financial data").
 */
@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly tokenService: TokenService,
    private readonly audit: AuditService,
    @Inject(EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  async createOrganization(
    dto: CreateOrganizationDto,
    actingUserId: string,
  ): Promise<{ organization: Organization; verificationTokenIssued: boolean }> {
    const actingUser = await this.userService.findById(actingUserId);
    if (!actingUser?.isPlatformSuperAdmin) {
      throw new PermissionError('Only the Platform Super Admin may provision an organization.');
    }

    // Decision 1 (global-identity model), resolved by explicit sign-off
    // after the Phase 1 report flagged this as an open decision: if
    // primaryContactEmail already belongs to an existing global User,
    // reuse that identity as the new organization's initial Admin rather
    // than creating a duplicate User. The User → OrganizationMembership →
    // Organization relationship is preserved — a brand-new Organization
    // and a brand-new OrganizationMembership are still created; only the
    // User row is reused.
    //
    // This mirrors the "mechanics" rule already established for the
    // regular invitation flow (MembershipService.invite): an existing,
    // already-verified identity does not need PENDING_VERIFICATION or a
    // new password — that status is reserved for a User's first-ever
    // membership (DATABASE_DESIGN.md §2). It still requires an explicit
    // accept of membership in *this* new organization (status INVITED),
    // consistent with never silently granting access to an org.
    const existingUser = await this.userService.findByEmail(dto.primaryContactEmail);

    const { raw: rawToken, hash: tokenHash } = this.tokenService.generate();
    const invitationExpiresAt = new Date();
    invitationExpiresAt.setDate(invitationExpiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    const result = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          legalName: dto.legalName,
          addressLine1: dto.addressLine1,
          city: dto.city,
          state: dto.state,
          zip: dto.zip,
          country: dto.country ?? 'US',
          primaryContactName: dto.primaryContactName,
          primaryContactEmail: dto.primaryContactEmail,
          primaryContactPhone: dto.primaryContactPhone,
          // defaultPaymentTerms defaults to NET_30 at the schema level
          // (Workflow 1 §1.1) — not set explicitly here.
          createdByUserId: actingUserId,
        },
      });

      // This transaction can't use PrismaService.withTenantTransaction()
      // (that helper requires organizationId to already exist BEFORE the
      // transaction opens) because the organization is created inside
      // this very transaction. Set the RLS session variable manually, the
      // moment the row exists, before inserting anything into the
      // RLS-protected organization_membership/membership_role tables
      // below — otherwise FORCE ROW LEVEL SECURITY (prisma/rls/0001_identity_rls.sql)
      // would reject those inserts (current_setting returns NULL until
      // set, and NULL never equals a real organization_id).
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organization.id}, true)`;

      await this.audit.record(tx, {
        organizationId: organization.id,
        action: 'Organization Created',
        entityType: 'Organization',
        entityId: organization.id,
        newValue: {
          legalName: organization.legalName,
          primaryContactEmail: dto.primaryContactEmail,
        },
        actorUserId: actingUserId,
      });

      // §1.2 Initial Admin Account Creation — same transaction. Reuse the
      // existing global User if one was found above; otherwise provision
      // a brand-new one exactly as before.
      const adminUser =
        existingUser ??
        (await this.userService.create(
          { email: dto.primaryContactEmail, name: dto.primaryContactName },
          tx,
        ));

      const membership = await tx.organizationMembership.create({
        data: {
          organizationId: organization.id,
          userId: adminUser.id,
          status: existingUser ? 'INVITED' : 'PENDING_VERIFICATION',
          invitedByUserId: null, // system-created, per §1.2
          invitedAt: new Date(),
          invitationTokenHash: tokenHash,
          invitationExpiresAt,
        },
      });

      await tx.membershipRole.create({
        data: { organizationId: organization.id, membershipId: membership.id, role: 'ADMIN' },
      });

      await this.audit.record(tx, {
        organizationId: organization.id,
        action: existingUser
          ? 'Initial Admin Assigned (Existing Identity)'
          : 'Initial Admin Account Created',
        entityType: 'User',
        entityId: adminUser.id,
        newValue: { email: adminUser.email, role: 'ADMIN' },
        actorType: 'SYSTEM',
      });

      return { organization, rawToken };
    });

    const emailContent = existingUser
      ? {
          subject: "You've been made the Admin of a new organization — Truck Master TMS",
          body: `You've been made the initial Admin of a new organization on Truck Master TMS. Accept: /accept-invitation?token=${result.rawToken}\nThis link expires in ${INVITATION_EXPIRY_DAYS} days.`,
        }
      : {
          subject: 'Verify your account — Truck Master TMS',
          body: `Welcome to Truck Master TMS. Verify your account: /verify?token=${result.rawToken}\nThis link expires in ${INVITATION_EXPIRY_DAYS} days.`,
        };

    await this.emailQueue.add(
      'send',
      {
        to: dto.primaryContactEmail,
        subject: emailContent.subject,
        body: emailContent.body,
        organizationId: result.organization.id,
        entityType: 'Organization',
        entityId: result.organization.id,
      } satisfies EmailJobData,
      EMAIL_JOB_OPTIONS,
    );

    return { organization: result.organization, verificationTokenIssued: true };
  }

  findById(id: string): Promise<Organization | null> {
    return this.prisma.organization.findUnique({ where: { id } });
  }

  /**
   * Frontend Phase 14 (Organization Settings). `organizationId` must
   * always come from the caller deriving it via
   * RequestContextStore.requireOrganizationId() — never from a
   * client-supplied id — this method has no other guard of its own,
   * unlike `findById` above (kept as-is for the platform-console path,
   * which never resolves an id from an authenticated org session).
   */
  getCurrent(organizationId: string): Promise<Organization> {
    return this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  }

  /**
   * Same field-change-diff + conditional-audit pattern as
   * LoadService.updateReferenceNumbers — no audit entry for a no-op
   * update, one "field_changes" entry per actually-changed field.
   * `defaultPaymentTerms` changes only affect future/default usage
   * (Workflow 2 §2.3) — nothing here touches existing Customer rows.
   *
   * Builds `data` from an explicit allowlist (UPDATABLE_ORGANIZATION_FIELDS)
   * rather than spreading `dto` directly — defense-in-depth alongside the
   * global ValidationPipe's `forbidNonWhitelisted`, so this service can
   * never forward `id`/`status`/`createdByUserId`/`createdAt` even if
   * called with an object that isn't a real, pipe-validated
   * UpdateOrganizationDto instance (e.g. a future internal caller).
   */
  async update(
    organizationId: string,
    dto: UpdateOrganizationDto,
    actingUserId: string,
  ): Promise<Organization> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });

      const fieldChanges: { field: string; previous: unknown; new: unknown }[] = [];
      const data: Record<string, unknown> = {};
      for (const field of UPDATABLE_ORGANIZATION_FIELDS) {
        const newValue = dto[field];
        if (newValue === undefined) continue;
        data[field] = newValue;
        const previousValue = (existing as unknown as Record<string, unknown>)[field];
        if (previousValue !== newValue) {
          fieldChanges.push({ field, previous: previousValue, new: newValue });
        }
      }

      const updated = await tx.organization.update({ where: { id: organizationId }, data });

      if (fieldChanges.length > 0) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Organization Settings Updated',
          entityType: 'Organization',
          entityId: organizationId,
          previousValue: { field_changes: fieldChanges },
          actorUserId: actingUserId,
        });
      }

      return updated;
    });
  }
}
