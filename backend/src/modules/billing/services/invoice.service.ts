import { Inject, Injectable } from '@nestjs/common';
import { InvoiceStatus, MembershipRoleName, PaymentTerms, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { OrganizationSequenceService } from '../../identity/services/organization-sequence.service';
import { EMAIL_SENDER, IEmailSender } from '../../../common/email/email-sender.interface';
import { StorageService } from '../../../common/storage/storage.service';
import { CreateInvoiceDto } from '../dto/create-invoice.dto';
import { SendInvoiceDto } from '../dto/send-invoice.dto';
import { RecordPaymentDto } from '../dto/record-payment.dto';
import { AddAdjustmentDto } from '../dto/add-adjustment.dto';
import { INVOICE_QUEUE, InvoiceJobData } from './invoice.constants';
import {
  BusinessRuleError,
  InvalidTransitionError,
  NotFoundError,
  PermissionError,
  PodIncompleteWarningError,
} from '../../../common/errors/app-error';

/** Workflow 8 §8.8 — due_date = send-time + this many days, computed server-side. */
const PAYMENT_TERMS_DAYS: Record<PaymentTerms, number> = {
  DUE_ON_RECEIPT: 0,
  NET_15: 15,
  NET_30: 30,
  NET_45: 45,
  NET_60: 60,
};

/** UI_UX_DESIGN.md §5.4.7 Permission Summary — full view; not a Workflow 8 action-taking role. */
const FULL_VIEW_ROLES: MembershipRoleName[] = ['ADMIN', 'ACCOUNTING', 'OPERATIONS_MANAGER'];

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: OrganizationSequenceService,
    private readonly storage: StorageService,
    @Inject(EMAIL_SENDER) private readonly emailSender: IEmailSender,
    @Inject(INVOICE_QUEUE) private readonly invoiceQueue: Queue,
  ) {}

  /**
   * Workflow 8 §8.1-8.5 — Invoice Builder. Individual (1 load) invoices
   * snapshot one InvoiceLineItem per ChargeLineItem (Decision Log D11);
   * consolidated (2+ loads) invoices snapshot one InvoiceLineItem per Load
   * (§8.5). One-invoice-per-Load is enforced via the transactional
   * `Load.invoiced` flag check (see schema.prisma's InvoiceLoad comment for
   * why no DB-level partial index backs this).
   */
  async create(organizationId: string, dto: CreateInvoiceDto, actingUserId: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const loads = await tx.load.findMany({
        where: { id: { in: dto.loadIds }, organizationId },
        include: { chargeLineItems: { include: { chargeType: true } } },
      });
      if (loads.length !== dto.loadIds.length) {
        throw new NotFoundError('One or more Loads not found.');
      }
      if (loads.some((l) => l.customerId !== dto.customerId)) {
        throw new BusinessRuleError('All selected Loads must belong to the same Customer.');
      }
      if (loads.some((l) => !['DELIVERED', 'CLOSED'].includes(l.status) || l.invoiced)) {
        throw new BusinessRuleError(
          'All selected Loads must be Delivered or Closed, and not already invoiced.',
        );
      }

      const incompletePod = loads.filter((l) => l.podStatus !== 'COMPLETE');
      if (incompletePod.length > 0 && !dto.podWarningAcknowledged) {
        throw new PodIncompleteWarningError('POD is incomplete for one or more selected Loads.', {
          affectedLoads: incompletePod.map((l) => l.id),
        });
      }

      const nextNumber = await this.sequences.getNextNumber(tx, organizationId, 'INVOICE');
      const invoiceNumber = this.sequences.format('INVOICE', nextNumber);

      const loadTotal = (loadId: string) =>
        loads
          .find((l) => l.id === loadId)!
          .chargeLineItems.filter((c) => c.side === 'CUSTOMER')
          .reduce((sum, c) => sum + Number(c.amount), 0);

      const isConsolidated = loads.length > 1;
      const lineItemsData: Prisma.InvoiceLineItemCreateManyInvoiceInput[] = isConsolidated
        ? loads.map((l) => ({
            organizationId,
            description: `Load ${l.loadNumber}`,
            amount: loadTotal(l.id).toFixed(2),
            sourceLoadId: l.id,
          }))
        : loads[0].chargeLineItems
            .filter((c) => c.side === 'CUSTOMER')
            .map((c) => ({
              organizationId,
              description: c.description ?? c.chargeType.label,
              amount: c.amount,
              sourceLoadId: loads[0].id,
              sourceChargeLineItemId: c.id,
            }));

      const total = lineItemsData.reduce((sum, li) => sum + Number(li.amount), 0).toFixed(2);

      const invoice = await tx.invoice.create({
        data: {
          organizationId,
          invoiceNumber,
          customerId: dto.customerId,
          status: 'DRAFT',
          total,
          remainingBalance: total,
          createdByUserId: actingUserId,
          invoiceLoads: {
            create: loads.map((l) => ({
              organizationId,
              loadId: l.id,
              loadTotalAtInvoice: loadTotal(l.id).toFixed(2),
            })),
          },
          lineItems: { createMany: { data: lineItemsData } },
        },
        include: { lineItems: true, invoiceLoads: true },
      });

      await tx.load.updateMany({
        where: { id: { in: dto.loadIds } },
        data: { invoiced: true },
      });

      await this.audit.record(tx, {
        organizationId,
        action: isConsolidated ? 'Invoice Created — Consolidated' : 'Invoice Created — Individual',
        entityType: 'Invoice',
        entityId: invoice.id,
        newValue: { invoiceNumber, loadIds: dto.loadIds, total },
        actorUserId: actingUserId,
      });

      if (incompletePod.length > 0 && dto.podWarningAcknowledged) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Invoice Created Despite Incomplete POD',
          entityType: 'Invoice',
          entityId: invoice.id,
          newValue: { affectedLoads: incompletePod.map((l) => l.id) },
          actorUserId: actingUserId,
        });
      }

      return invoice;
    });
  }

  /**
   * Workflow 8 §8.6/§8.8 — combines the DRAFT→SENT transition, due-date
   * computation, and the transactional email send into one action. Email
   * kept synchronous (approved Phase 6 Decision #6), mirroring the Rate
   * Confirmation precedent exactly — PDF generation is still queued
   * (off the request path), only the email itself is a direct call.
   */
  async send(organizationId: string, id: string, dto: SendInvoiceDto, actingUserId: string) {
    const { invoice, document } = await this.prisma.withTenantTransaction(
      organizationId,
      async (tx) => {
        const existing = await tx.invoice.findFirst({ where: { id, organizationId } });
        if (!existing) throw new NotFoundError('Invoice not found.');
        if (existing.status !== 'DRAFT') {
          throw new InvalidTransitionError('Only a Draft invoice can be sent.');
        }

        const customer = await tx.customer.findFirst({
          where: { id: existing.customerId, organizationId },
        });
        if (!customer) throw new NotFoundError('Customer not found.');

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + PAYMENT_TERMS_DAYS[customer.paymentTerms]);

        const documentType = await tx.documentTypeDefinition.findFirst({
          where: { code: 'INVOICE', OR: [{ organizationId }, { organizationId: null }] },
        });
        if (!documentType) throw new NotFoundError('Invoice document type is not configured.');

        const createdDoc = await tx.document.create({
          data: {
            organizationId,
            entityType: 'INVOICE',
            entityId: existing.id,
            documentTypeId: documentType.id,
            fileStorageKey: '',
            fileName: `Invoice-${existing.invoiceNumber}.pdf`,
            fileSizeBytes: 0,
            mimeType: 'application/pdf',
            versionNumber: 1,
            isCurrentVersion: true,
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            scanProvider: 'system-generated',
            reviewStatus: 'NOT_APPLICABLE',
            uploadedByUserId: actingUserId,
          },
        });
        const withKey = await tx.document.update({
          where: { id: createdDoc.id },
          data: { fileStorageKey: this.storage.buildDocumentKey(organizationId, createdDoc.id) },
        });

        const updated = await tx.invoice.update({
          where: { id },
          data: { status: 'SENT', sentAt: new Date(), dueDate },
        });

        await this.audit.record(tx, {
          organizationId,
          action: 'Invoice Sent',
          entityType: 'Invoice',
          entityId: id,
          newValue: { recipientEmail: dto.recipientEmail, dueDate: dueDate.toISOString() },
          actorUserId: actingUserId,
        });

        return { invoice: updated, document: withKey };
      },
    );

    const jobData: InvoiceJobData = { documentId: document.id, organizationId, invoiceId: id };
    await this.invoiceQueue.add('generate', jobData);

    await this.emailSender.send({
      to: dto.recipientEmail,
      subject: dto.subject,
      body: dto.message,
    });

    return invoice;
  }

  /** Workflow 8 §8.9 — cannot be recorded against a DRAFT invoice. */
  async recordPayment(
    organizationId: string,
    id: string,
    dto: RecordPaymentDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.invoice.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Invoice not found.');
      if (!['SENT', 'PARTIALLY_PAID'].includes(existing.status)) {
        throw new InvalidTransitionError('A payment can only be recorded against a Sent invoice.');
      }

      const payment = await tx.payment.create({
        data: {
          organizationId,
          invoiceId: id,
          amount: dto.amount,
          paymentDate: new Date(dto.paymentDate),
          method: dto.method,
          referenceNumber: dto.referenceNumber,
          notes: dto.notes,
          recordedByUserId: actingUserId,
        },
      });

      const { remainingBalance, status } = await this.recalculateInvoiceBalance(
        tx,
        organizationId,
        id,
      );

      await this.audit.record(tx, {
        organizationId,
        action: 'Payment Recorded',
        entityType: 'Invoice',
        entityId: id,
        newValue: { amount: dto.amount, method: dto.method, referenceNumber: dto.referenceNumber },
        actorUserId: actingUserId,
      });

      return { payment, remainingBalance, status };
    });
  }

  /** Workflow 8 §8.11 — reachable on SENT-or-later invoices, not DRAFT/VOID. No separate approval workflow. */
  async addAdjustment(
    organizationId: string,
    id: string,
    dto: AddAdjustmentDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.invoice.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Invoice not found.');
      if (existing.status === 'DRAFT' || existing.status === 'VOID') {
        throw new InvalidTransitionError('Adjustments require a Sent (or later-status) invoice.');
      }

      const adjustment = await tx.adjustment.create({
        data: {
          organizationId,
          invoiceId: id,
          type: dto.type,
          amount: dto.amount,
          reason: dto.reason,
          adjustmentDate: dto.adjustmentDate ? new Date(dto.adjustmentDate) : new Date(),
          createdByUserId: actingUserId,
        },
      });

      const { remainingBalance, status } = await this.recalculateInvoiceBalance(
        tx,
        organizationId,
        id,
      );

      await this.audit.record(tx, {
        organizationId,
        action: 'Invoice Adjustment Created',
        entityType: 'Invoice',
        entityId: id,
        newValue: { type: dto.type, amount: dto.amount, reason: dto.reason },
        actorUserId: actingUserId,
      });

      return { adjustment, remainingBalance, status };
    });
  }

  /** Workflow 8 §8.12 — reachable from any pre-Void status; releases its Loads back to the Ready-to-Invoice queue. */
  async void(organizationId: string, id: string, actingUserId: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.invoice.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Invoice not found.');
      if (existing.status === 'VOID') {
        throw new InvalidTransitionError('This Invoice is already Void.');
      }

      const invoiceLoads = await tx.invoiceLoad.findMany({
        where: { organizationId, invoiceId: id },
      });

      const updated = await tx.invoice.update({ where: { id }, data: { status: 'VOID' } });

      await tx.load.updateMany({
        where: { id: { in: invoiceLoads.map((il) => il.loadId) } },
        data: { invoiced: false },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Invoice Voided',
        entityType: 'Invoice',
        entityId: id,
        previousValue: { status: existing.status },
        newValue: { releasedLoadIds: invoiceLoads.map((il) => il.loadId) },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /**
   * UI_UX_DESIGN.md §5.4.7 Permission Summary — Dispatcher/Compliance
   * Reviewer blocked entirely (guard-level, `@Roles` on the controller);
   * Admin/Accounting/Ops Manager see full detail; Sales/Booking sees full
   * detail only for their own Customer's invoices (Account Owner, fallback
   * creator — §5.4.5's exact rule) and is otherwise blocked here (not
   * "independently linkable" per the locked spec — the redacted, listable-
   * only view lives in `list()`, not here).
   */
  async findById(
    organizationId: string,
    id: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ) {
    const invoice = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.invoice.findFirst({
        where: { id, organizationId },
        include: {
          lineItems: true,
          payments: true,
          adjustments: true,
          invoiceLoads: true,
          customer: true,
        },
      }),
    );
    if (!invoice) throw new NotFoundError('Invoice not found.');

    if (actingRoles.some((r) => FULL_VIEW_ROLES.includes(r))) return invoice;
    if (actingRoles.includes('SALES_BOOKING') && this.isOwnDeal(invoice.customer, actingUserId)) {
      return invoice;
    }
    throw new PermissionError('You do not have permission to view this Invoice.');
  }

  async list(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: { customerId?: string; status?: string } = {},
  ) {
    if (!actingRoles.some((r) => [...FULL_VIEW_ROLES, 'SALES_BOOKING'].includes(r))) {
      throw new PermissionError('You do not have permission to view Invoices.');
    }

    const invoices = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.invoice.findMany({
        where: {
          organizationId,
          ...(filters.customerId ? { customerId: filters.customerId } : {}),
          ...(filters.status ? { status: filters.status as InvoiceStatus } : {}),
        },
        include: { customer: true },
        orderBy: { createdAt: 'desc' },
      }),
    );

    if (actingRoles.some((r) => FULL_VIEW_ROLES.includes(r))) return invoices;

    // Sales/Booking: full row for own-deal invoices, status-only (amounts
    // redacted) for everyone else's — UI_UX_DESIGN.md §5.4.5's exact rule.
    return invoices.map((invoice) =>
      this.isOwnDeal(invoice.customer, actingUserId)
        ? invoice
        : { ...invoice, total: null, remainingBalance: null, dueDate: null },
    );
  }

  /** UI_UX_DESIGN.md §5.4.5 — "Account Owner, fallback creator" own-deal rule. */
  private isOwnDeal(
    customer: { accountOwnerUserId: string | null; createdByUserId: string },
    actingUserId: string,
  ): boolean {
    return customer.accountOwnerUserId
      ? customer.accountOwnerUserId === actingUserId
      : customer.createdByUserId === actingUserId;
  }

  /**
   * Shared recalculation for Payment/Adjustment mutations — `total` is
   * fixed at creation (no locked flow adds line items after the fact), only
   * `remaining_balance`/`status` are recomputed. CREDITED vs PAID: PAID if
   * any payment contributed, CREDITED if the balance was fully offset by
   * adjustments alone (Workflow 8 §8.12's "fully offset via Credit
   * Adjustments... rather than payment").
   */
  private async recalculateInvoiceBalance(
    tx: Prisma.TransactionClient,
    organizationId: string,
    invoiceId: string,
  ): Promise<{ remainingBalance: string; status: InvoiceStatus }> {
    const invoice = await tx.invoice.findFirstOrThrow({ where: { id: invoiceId, organizationId } });
    const payments = await tx.payment.findMany({ where: { organizationId, invoiceId } });
    const adjustments = await tx.adjustment.findMany({ where: { organizationId, invoiceId } });

    const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalCredit = adjustments
      .filter((a) => a.type === 'CREDIT')
      .reduce((sum, a) => sum + Number(a.amount), 0);
    const totalDebit = adjustments
      .filter((a) => a.type === 'DEBIT')
      .reduce((sum, a) => sum + Number(a.amount), 0);

    const remaining = Number(invoice.total) - totalPaid - totalCredit + totalDebit;
    const remainingBalance = remaining.toFixed(2);

    let status = invoice.status;
    if (status !== 'VOID') {
      if (remaining <= 0) {
        status = totalPaid > 0 ? 'PAID' : 'CREDITED';
      } else if (totalPaid > 0) {
        status = 'PARTIALLY_PAID';
      }
    }

    await tx.invoice.update({ where: { id: invoiceId }, data: { remainingBalance, status } });
    return { remainingBalance, status };
  }
}
