import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { TokenService } from './token.service';
import { UserService } from './user.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { PermissionError } from '../../../common/errors/app-error';
import { EMAIL_SENDER, IEmailSender } from '../../../common/email/email-sender.interface';

const INVITATION_EXPIRY_DAYS = 7;

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
    @Inject(EMAIL_SENDER) private readonly emailSender: IEmailSender,
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

    await this.emailSender.send(
      existingUser
        ? {
            to: dto.primaryContactEmail,
            subject: "You've been made the Admin of a new organization — Truck Master TMS",
            body: `You've been made the initial Admin of a new organization on Truck Master TMS. Accept: /accept-invitation?token=${result.rawToken}\nThis link expires in ${INVITATION_EXPIRY_DAYS} days.`,
          }
        : {
            to: dto.primaryContactEmail,
            subject: 'Verify your account — Truck Master TMS',
            body: `Welcome to Truck Master TMS. Verify your account: /verify?token=${result.rawToken}\nThis link expires in ${INVITATION_EXPIRY_DAYS} days.`,
          },
    );

    return { organization: result.organization, verificationTokenIssued: true };
  }

  findById(id: string): Promise<Organization | null> {
    return this.prisma.organization.findUnique({ where: { id } });
  }
}
