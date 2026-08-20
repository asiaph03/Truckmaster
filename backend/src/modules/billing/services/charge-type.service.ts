import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { CreateChargeTypeDto } from '../dto/create-charge-type.dto';
import { UpdateChargeTypeDto } from '../dto/update-charge-type.dto';
import { NotFoundError } from '../../../common/errors/app-error';

/**
 * Decision Log B3 — Admin-only management of ChargeTypeDefinition
 * (distinct from D9's broader "use an existing type to add a charge"
 * permission, handled by LoadService.addCharge). Mirrors DocumentType's
 * nullable-organizationId lookup-table pattern exactly.
 */
@Injectable()
export class ChargeTypeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.chargeTypeDefinition.findMany({
        where: { OR: [{ organizationId }, { organizationId: null }] },
        orderBy: { label: 'asc' },
      }),
    );
  }

  /** Org-scoped custom type — system defaults (organizationId=null) are never created through this path. */
  async create(organizationId: string, dto: CreateChargeTypeDto, actingUserId: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const created = await tx.chargeTypeDefinition.create({
        data: { organizationId, code: dto.code, label: dto.label, isSystemDefault: false },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Charge Type Created',
        entityType: 'ChargeTypeDefinition',
        entityId: created.id,
        newValue: { code: created.code, label: created.label },
        actorUserId: actingUserId,
      });

      return created;
    });
  }

  /**
   * Label-only edit — `code` is a stable identifier referenced elsewhere
   * (e.g. the ORIGINAL-linehaul lookup in LoadService/CarrierSourcingService)
   * and is never mutated after creation. Only org-owned rows are editable —
   * a null-org system default can never be updated through this path.
   */
  async update(organizationId: string, id: string, dto: UpdateChargeTypeDto, actingUserId: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.chargeTypeDefinition.findFirst({
        where: { id, organizationId },
      });
      if (!existing) throw new NotFoundError('Charge type not found.');

      const updated = await tx.chargeTypeDefinition.update({
        where: { id },
        data: { label: dto.label },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Charge Type Updated',
        entityType: 'ChargeTypeDefinition',
        entityId: id,
        previousValue: { label: existing.label },
        newValue: { label: updated.label },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }
}
