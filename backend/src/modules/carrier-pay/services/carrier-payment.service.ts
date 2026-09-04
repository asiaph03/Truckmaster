import { Inject, Injectable } from '@nestjs/common';
import { CarrierPaymentStatus, Load, MembershipRoleName, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { CreateCarrierPaymentDto } from '../dto/create-carrier-payment.dto';
import { RejectCarrierPaymentDto } from '../dto/reject-carrier-payment.dto';
import { MarkPaidDto } from '../dto/mark-paid.dto';
import {
  SETTLEMENT_QUEUE,
  SETTLEMENT_JOB_OPTIONS,
  SettlementJobData,
} from './settlement.constants';
import {
  BusinessRuleError,
  InvalidTransitionError,
  NotFoundError,
  PermissionError,
  SelfReviewForbiddenError,
} from '../../../common/errors/app-error';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';

/**
 * UI_UX_DESIGN.md §5.1.6 — Billing nav (Carrier Pay included) hidden
 * entirely from Dispatcher; Sales/Booking's carve-out is scoped to Invoice
 * status only, not Carrier Pay. Role gating for create/submit/approve/
 * reject/mark-paid lives at the controller (`@Roles`, Workflow 9
 * Cross-Cutting Permissions) — this service only needs the view-role check
 * below, since fine-grained checks (self-approval, status gates) already
 * cover the mutation paths.
 */

@Injectable()
export class CarrierPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(SETTLEMENT_QUEUE) private readonly settlementQueue: Queue,
  ) {}

  /** Workflow 9 §9.1-9.2 — Load must be Delivered or later; independent of Invoicing/POD status. */
  async create(
    organizationId: string,
    loadId: string,
    dto: CreateCarrierPaymentDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (!['DELIVERED', 'CLOSED'].includes(load.status)) {
        throw new BusinessRuleError(
          'The Load must be Delivered or later to create a Carrier Payment.',
        );
      }
      if (!load.assignedCarrierId) {
        throw new BusinessRuleError('The Load has no assigned Carrier.');
      }

      const created = await tx.carrierPayment.create({
        data: {
          organizationId,
          loadId,
          carrierId: load.assignedCarrierId,
          amount: dto.amount,
          paymentType: dto.paymentType,
          method: dto.method,
          referenceNumber: dto.referenceNumber,
          notes: dto.notes,
          status: 'DRAFT',
          preparedByUserId: actingUserId,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Payment Created — Draft',
        entityType: 'CarrierPayment',
        entityId: created.id,
        newValue: { amount: dto.amount, paymentType: dto.paymentType },
        actorUserId: actingUserId,
      });

      // Accessorial Charges on in-transit Loads — surfaces the up-to-date
      // carrier balance (linehaul + any carrier-side accessorial
      // ADJUSTMENT ChargeLineItems, e.g. Detention added while the Load
      // was In Transit) the moment a settlement is created, so Accounting
      // never misses an accessorial when preparing a payment. `amount`
      // itself is never touched — it stays exactly what the preparer
      // typed (Decision Log D10: no line-item allocation).
      const { remainingCarrierBalance } = await this.computeCarrierBalance(
        tx,
        organizationId,
        load,
      );

      return { ...created, remainingCarrierBalance };
    });
  }

  /**
   * Accessorial Charges on in-transit Loads — read-only balance PREVIEW,
   * so Accounting sees carrierRate + carrier-side accessorial
   * ChargeLineItems - already-Paid BEFORE typing an amount into
   * CreateCarrierPaymentModal, not just after submitting it (create()'s
   * own returned remainingCarrierBalance is too late to inform what the
   * preparer types). Creates nothing; reuses the exact same
   * `computeCarrierBalance` formula create() uses — never a second,
   * divergent calculation.
   */
  async getRemainingBalance(
    organizationId: string,
    loadId: string,
    actingRoles: MembershipRoleName[],
  ) {
    if (!actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r))) {
      throw new PermissionError('You do not have permission to view Carrier Payment balances.');
    }
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');

      const { carrierAccessorialsTotal, totalPaid, remainingCarrierBalance } =
        await this.computeCarrierBalance(tx, organizationId, load);

      return {
        carrierRate: load.carrierRate ? load.carrierRate.toString() : null,
        carrierAccessorialsTotal,
        totalPaid,
        remainingCarrierBalance: remainingCarrierBalance ?? null,
      };
    });
  }

  /**
   * Single source of truth for carrierRate + carrier-side ADJUSTMENT
   * ChargeLineItems - already-Paid, shared by create() (post-creation
   * echo) and getRemainingBalance() (pre-creation preview) — Decision
   * Log D10 still holds (no line-item allocation persisted onto
   * CarrierPayment.amount itself; this is read-only). Summing only
   * ADJUSTMENT rows (never ORIGINAL, which carrierRate already mirrors)
   * means a Load with zero carrier accessorials adds exactly $0, leaving
   * every pre-existing figure byte-identical to before this feature.
   * Customer-side ChargeLineItems are never queried here at all.
   */
  private async computeCarrierBalance(
    tx: Prisma.TransactionClient,
    organizationId: string,
    load: Pick<Load, 'id' | 'carrierRate'>,
  ): Promise<{
    carrierAccessorialsTotal: string;
    totalPaid: string;
    remainingCarrierBalance: string | undefined;
  }> {
    const carrierAccessorials = await tx.chargeLineItem.findMany({
      where: { organizationId, loadId: load.id, side: 'CARRIER', source: 'ADJUSTMENT' },
    });
    const carrierAccessorialsTotal = carrierAccessorials.reduce(
      (sum, c) => sum + Number(c.amount),
      0,
    );

    const existingPayments = await tx.carrierPayment.findMany({
      where: { organizationId, loadId: load.id },
    });
    const totalPaid = existingPayments
      .filter((p) => p.status === 'PAID')
      .reduce((sum, p) => sum + Number(p.amount), 0);

    const remainingCarrierBalance = load.carrierRate
      ? (Number(load.carrierRate) + carrierAccessorialsTotal - totalPaid).toFixed(2)
      : undefined;

    return {
      carrierAccessorialsTotal: carrierAccessorialsTotal.toFixed(2),
      totalPaid: totalPaid.toFixed(2),
      remainingCarrierBalance,
    };
  }

  /** Workflow 9 §9.3 — amount locked in at submission; method/reference must already be present. */
  async submit(organizationId: string, id: string, actingUserId: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.carrierPayment.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Carrier Payment not found.');
      if (existing.status !== 'DRAFT') {
        throw new InvalidTransitionError(
          'Only a Draft Carrier Payment can be submitted for approval.',
        );
      }
      if (!existing.method || !existing.referenceNumber) {
        throw new BusinessRuleError('Method and reference number are required before submission.');
      }

      const updated = await tx.carrierPayment.update({
        where: { id },
        data: { status: 'PENDING_APPROVAL', submittedAt: new Date() },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Payment Submitted for Approval',
        entityType: 'CarrierPayment',
        entityId: id,
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /** Workflow 9 §9.4 — Admin only, self-approval blocked, amount immutable at this step. */
  async approve(organizationId: string, id: string, actingUserId: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.carrierPayment.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Carrier Payment not found.');
      if (existing.status !== 'PENDING_APPROVAL') {
        throw new InvalidTransitionError(
          'Only a Pending Approval Carrier Payment can be approved.',
        );
      }
      if (existing.preparedByUserId === actingUserId) {
        throw new SelfReviewForbiddenError('You cannot approve a Carrier Payment you prepared.');
      }

      const updated = await tx.carrierPayment.update({
        where: { id },
        data: { status: 'APPROVED', approvedByUserId: actingUserId, approvedAt: new Date() },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Payment Approved',
        entityType: 'CarrierPayment',
        entityId: id,
        newValue: { amount: existing.amount.toString() },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /** Workflow 9 §9.4-9.5 — returns to DRAFT (no separate REJECTED terminal state), no cycle limit. */
  async reject(
    organizationId: string,
    id: string,
    dto: RejectCarrierPaymentDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.carrierPayment.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Carrier Payment not found.');
      if (existing.status !== 'PENDING_APPROVAL') {
        throw new InvalidTransitionError(
          'Only a Pending Approval Carrier Payment can be rejected.',
        );
      }
      if (existing.preparedByUserId === actingUserId) {
        throw new SelfReviewForbiddenError('You cannot reject a Carrier Payment you prepared.');
      }

      const updated = await tx.carrierPayment.update({
        where: { id },
        data: {
          status: 'DRAFT',
          lastRejectedByUserId: actingUserId,
          lastRejectedAt: new Date(),
          lastRejectionReason: dto.reason,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Payment Rejected',
        entityType: 'CarrierPayment',
        entityId: id,
        newValue: { reason: dto.reason },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /** Workflow 9 §9.6/§9.8 — only from APPROVED; generates the per-payment settlement document. */
  async markPaid(organizationId: string, id: string, dto: MarkPaidDto, actingUserId: string) {
    const { carrierPayment, document } = await this.prisma.withTenantTransaction(
      organizationId,
      async (tx) => {
        const existing = await tx.carrierPayment.findFirst({
          where: { id, organizationId },
          include: { carrier: true, load: true },
        });
        if (!existing) throw new NotFoundError('Carrier Payment not found.');
        if (existing.status !== 'APPROVED') {
          throw new InvalidTransitionError('Only an Approved Carrier Payment can be marked Paid.');
        }

        const updated = await tx.carrierPayment.update({
          where: { id },
          data: {
            status: 'PAID',
            paidAt: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          },
        });

        const documentType = await tx.documentTypeDefinition.findFirst({
          where: { code: 'SETTLEMENT', OR: [{ organizationId }, { organizationId: null }] },
        });
        if (!documentType) throw new NotFoundError('Settlement document type is not configured.');

        const createdDoc = await tx.document.create({
          data: {
            organizationId,
            entityType: 'CARRIER_PAYMENT',
            entityId: id,
            documentTypeId: documentType.id,
            fileStorageKey: '',
            fileName: `Settlement-${existing.load.loadNumber}-${id}.pdf`,
            fileSizeBytes: 0,
            mimeType: 'application/pdf',
            versionNumber: 1,
            isCurrentVersion: true,
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            scanProvider: 'system-generated',
            reviewStatus: 'NOT_APPLICABLE',
            generationStatus: 'PENDING',
            uploadedByUserId: actingUserId,
          },
        });
        const withKey = await tx.document.update({
          where: { id: createdDoc.id },
          data: { fileStorageKey: this.storage.buildDocumentKey(organizationId, createdDoc.id) },
        });

        await this.audit.record(tx, {
          organizationId,
          action: 'Carrier Payment Paid',
          entityType: 'CarrierPayment',
          entityId: id,
          newValue: { amount: existing.amount.toString(), paidAt: updated.paidAt?.toISOString() },
          actorUserId: actingUserId,
        });

        await this.audit.record(tx, {
          organizationId,
          action: 'Settlement Document Generated',
          entityType: 'CarrierPayment',
          entityId: id,
          newValue: { documentId: withKey.id },
          actorType: 'SYSTEM',
        });

        return { carrierPayment: updated, document: withKey };
      },
    );

    const jobData: SettlementJobData = {
      documentId: document.id,
      organizationId,
      carrierPaymentId: id,
    };
    await this.settlementQueue.add('generate', jobData, SETTLEMENT_JOB_OPTIONS);

    return carrierPayment;
  }

  async findById(organizationId: string, id: string, actingRoles: MembershipRoleName[]) {
    if (!actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r))) {
      throw new PermissionError('You do not have permission to view Carrier Payments.');
    }
    const carrierPayment = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.carrierPayment.findFirst({ where: { id, organizationId } }),
    );
    if (!carrierPayment) throw new NotFoundError('Carrier Payment not found.');
    return carrierPayment;
  }

  async list(
    organizationId: string,
    actingRoles: MembershipRoleName[],
    filters: { loadId?: string; status?: string } = {},
  ) {
    if (!actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r))) {
      throw new PermissionError('You do not have permission to view Carrier Payments.');
    }
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.carrierPayment.findMany({
        where: {
          organizationId,
          ...(filters.loadId ? { loadId: filters.loadId } : {}),
          ...(filters.status ? { status: filters.status as CarrierPaymentStatus } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
