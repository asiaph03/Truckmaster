import { Injectable } from '@nestjs/common';
import { DocumentTypeCategory } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Frontend Phase 2 gap-fix — read-only lookup for the `documentTypeId`
 * every `POST /documents` call requires. Mirrors ChargeTypeService's
 * nullable-organizationId lookup-table read pattern exactly; deliberately
 * has no create/update — type management stays seed-only, out of scope
 * per the approved plan ("keep it minimal and do not expand into general
 * document-type management").
 */
@Injectable()
export class DocumentTypeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, category?: DocumentTypeCategory) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.documentTypeDefinition.findMany({
        where: {
          OR: [{ organizationId }, { organizationId: null }],
          ...(category ? { category } : {}),
        },
        orderBy: { label: 'asc' },
      }),
    );
  }
}
