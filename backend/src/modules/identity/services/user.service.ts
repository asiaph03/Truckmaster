import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Global User operations (DATABASE_DESIGN.md §2, Architecture Decision 1).
 * No organization scoping here by definition — User is one of the two
 * tables (with Organization) that carries no organization_id and no RLS
 * policy (§26). Callers are responsible for tenant-scoping wherever a
 * User is used in an org-scoped context (e.g. OrganizationMembership).
 */
@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * Creates a brand-new global identity. Callers must have already
   * confirmed no User exists for this email (Decision 1 — the same email
   * is never silently given two independent global identities).
   */
  create(
    data: Pick<Prisma.UserCreateInput, 'email' | 'name'>,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return tx.user.create({
      data: {
        email: data.email,
        name: data.name,
        status: 'PENDING_VERIFICATION',
      },
    });
  }

  async setPasswordAndActivate(
    userId: string,
    passwordHash: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
  }

  async updateProfile(
    userId: string,
    data: { name?: string; passwordHash?: string },
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.passwordHash ? { passwordHash: data.passwordHash } : {}),
      },
    });
  }
}
