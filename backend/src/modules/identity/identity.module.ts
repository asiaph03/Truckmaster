import { Module } from '@nestjs/common';
import { EMAIL_SENDER } from '../../common/email/email-sender.interface';
import { ConsoleEmailSender } from '../../common/email/console-email-sender';
import { UserService } from './services/user.service';
import { OrganizationService } from './services/organization.service';
import { OrganizationSequenceService } from './services/organization-sequence.service';
import { MembershipService } from './services/membership.service';
import { AuthService } from './services/auth.service';
import { TokenService } from './services/token.service';
import { PasswordService } from './services/password.service';
import { SessionRegistryService } from './services/session-registry.service';
import { AuthController } from './controllers/auth.controller';
import { OrganizationsController } from './controllers/organizations.controller';
import { OrganizationSettingsController } from './controllers/organization-settings.controller';
import { MembershipsController } from './controllers/memberships.controller';
import { PlatformSuperAdminGuard } from './guards/platform-super-admin.guard';

/**
 * Identity & Organization modules (TECHNICAL_ARCHITECTURE.md §1.2) — kept
 * as one NestJS module for Phase 1 since they're small and tightly
 * coupled (Organization creation directly creates the initial
 * Membership); the module-boundary *ownership* split from §1.2 (Identity
 * owns User/OrganizationMembership/MembershipRole, Organization owns
 * Organization/OrganizationSequence) is preserved at the service-class
 * level even though they share one NestJS module wrapper.
 */
@Module({
  controllers: [
    AuthController,
    OrganizationsController,
    OrganizationSettingsController,
    MembershipsController,
  ],
  providers: [
    UserService,
    OrganizationService,
    OrganizationSequenceService,
    MembershipService,
    AuthService,
    TokenService,
    PasswordService,
    SessionRegistryService,
    PlatformSuperAdminGuard,
    { provide: EMAIL_SENDER, useClass: ConsoleEmailSender },
  ],
  exports: [UserService, MembershipService, AuthService, OrganizationSequenceService],
})
export class IdentityModule {}
