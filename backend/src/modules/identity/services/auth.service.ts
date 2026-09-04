import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { MembershipService } from './membership.service';
import { AuthenticationError, ValidationError } from '../../../common/errors/app-error';
import { SessionData } from '../session.types';
import { UpdateProfileDto } from '../dto/update-profile.dto';

export interface LoginResult {
  session: SessionData;
  /** true when the account has >1 active membership and must pick one before session.organizationId is set */
  requiresOrganizationSelection: boolean;
  organizations: { id: string; legalName: string }[];
}

/**
 * TECHNICAL_ARCHITECTURE.md §3.2 — session establishment. Session
 * persistence itself (Redis-backed, HttpOnly/Secure/SameSite=Lax cookie)
 * is wired at the Express/NestJS level in identity.module.ts / main.ts;
 * this service only decides *what* goes into the session payload.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly passwordService: PasswordService,
    private readonly membershipService: MembershipService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.userService.findByEmail(email);
    // Deliberately identical error for "no such user" and "wrong password"
    // — do not reveal which one it was (standard credential-stuffing
    // hardening; not a business rule from any locked document, a
    // technical default per §11).
    if (!user || !user.passwordHash) {
      throw new AuthenticationError('Invalid email or password.');
    }
    if (user.status !== 'ACTIVE') {
      throw new AuthenticationError('Invalid email or password.');
    }

    const valid = await this.passwordService.verify(password, user.passwordHash);
    if (!valid) {
      throw new AuthenticationError('Invalid email or password.');
    }

    const memberships = await this.membershipService.listActiveMemberships(user.id);

    if (memberships.length === 1) {
      const membership = memberships[0];
      const roles = await this.membershipService.getRoles(membership.organizationId, user.id);
      return {
        session: {
          userId: user.id,
          organizationId: membership.organizationId,
          membershipId: membership.id,
          roles,
        },
        requiresOrganizationSelection: false,
        organizations: [],
      };
    }

    if (memberships.length === 0) {
      // Identity is valid but has no workspace to enter yet (e.g. only a
      // still-PENDING_VERIFICATION or INVITED membership exists) — not an
      // authentication failure, just nothing to select. Session carries
      // userId only, matching §3.2's "if zero... no workspace is
      // available."
      return {
        session: { userId: user.id },
        requiresOrganizationSelection: false,
        organizations: [],
      };
    }

    // >1 active membership — §3.2's "org-pending state."
    return {
      session: { userId: user.id },
      requiresOrganizationSelection: true,
      organizations: memberships.map((m) => ({
        id: m.organizationId,
        legalName: m.organization.legalName,
      })),
    };
  }

  async selectOrganization(userId: string, organizationId: string): Promise<SessionData> {
    return this.resolveOrganizationSession(userId, organizationId);
  }

  /** §3.3 — a full context switch, never a partial in-place merge. */
  async switchOrganization(userId: string, organizationId: string): Promise<SessionData> {
    return this.resolveOrganizationSession(userId, organizationId);
  }

  private async resolveOrganizationSession(
    userId: string,
    organizationId: string,
  ): Promise<SessionData> {
    const membership = await this.prisma.withUserTransaction(userId, (tx) =>
      tx.organizationMembership.findFirst({
        where: { userId, organizationId, status: 'ACTIVE' },
      }),
    );
    if (!membership) {
      throw new AuthenticationError('No active membership found for that organization.');
    }
    const roles = await this.membershipService.getRoles(organizationId, userId);
    return { userId, organizationId, membershipId: membership.id, roles };
  }

  async getProfile(
    userId: string,
  ): Promise<Pick<User, 'id' | 'name' | 'email' | 'status' | 'isPlatformSuperAdmin'>> {
    const user = await this.userService.findById(userId);
    if (!user) throw new AuthenticationError('User not found.');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      isPlatformSuperAdmin: user.isPlatformSuperAdmin,
    };
  }

  /**
   * UI_UX_DESIGN.md §5.6 SH-9 — name + password only. Never touches
   * OrganizationMembership/MembershipRole (organization membership, roles,
   * and permissions stay outside self-service editing, per that decision).
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<void> {
    if (!dto.name && !dto.password) {
      throw new ValidationError('Provide a name and/or password to update.');
    }
    const passwordHash = dto.password ? await this.passwordService.hash(dto.password) : undefined;
    await this.userService.updateProfile(userId, { name: dto.name, passwordHash });
  }
}
