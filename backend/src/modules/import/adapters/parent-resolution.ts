import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

export type ParentResolutionResult = { id: string } | { error: string };

/**
 * Approved technical design, Decision 4/parent-resolution — exact
 * case-insensitive legal-name match within the current organization; zero
 * or multiple matches is a row-level validation error. No new cross-file
 * ID scheme.
 */
@Injectable()
export class ParentResolutionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveByLegalName(
    organizationId: string,
    parentEntity: 'CUSTOMER' | 'CARRIER',
    legalName: string | undefined,
  ): Promise<ParentResolutionResult> {
    const trimmed = (legalName ?? '').trim();
    if (!trimmed) {
      return { error: 'Parent legal name is required.' };
    }

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const matches =
        parentEntity === 'CUSTOMER'
          ? await tx.customer.findMany({
              where: { organizationId, legalName: { equals: trimmed, mode: 'insensitive' } },
              select: { id: true },
            })
          : await tx.carrier.findMany({
              where: { organizationId, legalName: { equals: trimmed, mode: 'insensitive' } },
              select: { id: true },
            });

      if (matches.length === 0) {
        return {
          error: `No ${parentEntity === 'CUSTOMER' ? 'customer' : 'carrier'} found named "${trimmed}".`,
        };
      }
      if (matches.length > 1) {
        return {
          error: `${matches.length} ${parentEntity === 'CUSTOMER' ? 'customers' : 'carriers'} found named "${trimmed}" — cannot resolve uniquely.`,
        };
      }
      return { id: matches[0].id };
    });
  }
}
