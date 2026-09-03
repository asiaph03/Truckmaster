import { Injectable } from '@nestjs/common';
import { Customer, Document, LoadDraft, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundError } from '../../../common/errors/app-error';
import { CreateLoadDraftDto } from '../dto/create-load-draft.dto';
import { ExtractedRateConfirmationData } from '../../rate-confirmation-extraction/rate-confirmation-extractor.interface';

export interface LoadDraftSummary {
  id: string;
  customerId: string;
  customerLegalName: string;
  customerStatus: string;
  rateConfirmationDocumentId: string;
  rateConfirmationFileName: string;
  createdAt: Date;
}

export interface LoadDraftDetail extends LoadDraftSummary {
  extractedData: ExtractedRateConfirmationData;
}

/**
 * Rate Confirmation → New Load auto-populate feature — Load Draft.
 * NON-NEGOTIABLE per the approved design: the Anthropic extractor and the
 * Redis extraction job store are NEVER touched by this service, in any
 * method. `create()` snapshots the already-computed extraction result
 * (received verbatim from the frontend, which already had it in hand
 * from the same extraction session) exactly once; every other method
 * only ever reads that durable Postgres snapshot back. This is what lets
 * a draft survive well past the Redis job's 1-hour TTL without a second
 * LLM call.
 *
 * No status field on LoadDraft itself (see the model's own schema.prisma
 * doc comment) — "waiting" vs. "ready to book" is always derived from
 * the live `Customer.status`, returned inline here on every read, never
 * cached/duplicated. Booking itself (LoadService.createDirect) is
 * completely untouched by this module and still re-validates that same
 * Customer status server-side on its own, independent of anything here.
 */
@Injectable()
export class LoadDraftService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizationId: string,
    actingUserId: string,
    dto: CreateLoadDraftDto,
  ): Promise<LoadDraftDetail> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const document = await tx.document.findFirst({
        where: {
          organizationId,
          entityType: 'RATE_CONFIRMATION_INTAKE',
          entityId: dto.extractionId,
          isCurrentVersion: true,
        },
      });
      if (!document) throw new NotFoundError('Rate Confirmation upload not found.');

      const customer = await tx.customer.findFirst({
        where: { id: dto.customerId, organizationId },
      });
      if (!customer) throw new NotFoundError('Customer not found.');

      // Idempotent — a second create() for the same source document (e.g.
      // a double-click, or a network retry) returns the existing draft
      // rather than erroring on the unique constraint or creating a
      // duplicate. This check-then-create is not atomic on its own — two
      // genuinely concurrent requests could both pass it before either
      // commits — so the create below also catches the resulting unique-
      // constraint violation (P2002) as a fallback and re-fetches the
      // winner's row, rather than letting a race surface as a 500.
      const existing = await tx.loadDraft.findFirst({
        where: { organizationId, rateConfirmationDocumentId: document.id },
      });
      if (existing) return this.toDetail(existing, customer, document);

      let created;
      try {
        created = await tx.loadDraft.create({
          data: {
            organizationId,
            createdByUserId: actingUserId,
            customerId: dto.customerId,
            rateConfirmationDocumentId: document.id,
            extractedData: dto.extractedData as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const winner = await tx.loadDraft.findFirst({
            where: { organizationId, rateConfirmationDocumentId: document.id },
          });
          if (winner) return this.toDetail(winner, customer, document);
        }
        throw error;
      }

      return this.toDetail(created, customer, document);
    });
  }

  async get(organizationId: string, id: string): Promise<LoadDraftDetail> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const draft = await tx.loadDraft.findFirst({ where: { id, organizationId } });
      if (!draft) throw new NotFoundError('Load draft not found.');

      const [customer, document] = await Promise.all([
        tx.customer.findFirst({ where: { id: draft.customerId, organizationId } }),
        tx.document.findFirst({ where: { id: draft.rateConfirmationDocumentId, organizationId } }),
      ]);
      if (!customer || !document) throw new NotFoundError('Load draft not found.');

      return this.toDetail(draft, customer, document);
    });
  }

  async list(organizationId: string): Promise<LoadDraftSummary[]> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const drafts = await tx.loadDraft.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
      });
      if (drafts.length === 0) return [];

      const customerIds = [...new Set(drafts.map((d) => d.customerId))];
      const documentIds = [...new Set(drafts.map((d) => d.rateConfirmationDocumentId))];
      const [customers, documents] = await Promise.all([
        tx.customer.findMany({ where: { id: { in: customerIds }, organizationId } }),
        tx.document.findMany({ where: { id: { in: documentIds }, organizationId } }),
      ]);
      const customerById = new Map(customers.map((c) => [c.id, c]));
      const documentById = new Map(documents.map((d) => [d.id, d]));

      return drafts
        .filter(
          (d) => customerById.has(d.customerId) && documentById.has(d.rateConfirmationDocumentId),
        )
        .map((d) =>
          this.toSummary(
            d,
            customerById.get(d.customerId)!,
            documentById.get(d.rateConfirmationDocumentId)!,
          ),
        );
    });
  }

  /** Idempotent — deleting an already-gone/unowned draft is a silent no-op, never an error. */
  async delete(organizationId: string, id: string): Promise<void> {
    await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      await tx.loadDraft.deleteMany({ where: { id, organizationId } });
    });
  }

  private toSummary(draft: LoadDraft, customer: Customer, document: Document): LoadDraftSummary {
    return {
      id: draft.id,
      customerId: draft.customerId,
      customerLegalName: customer.legalName,
      customerStatus: customer.status,
      rateConfirmationDocumentId: draft.rateConfirmationDocumentId,
      rateConfirmationFileName: document.fileName,
      createdAt: draft.createdAt,
    };
  }

  private toDetail(draft: LoadDraft, customer: Customer, document: Document): LoadDraftDetail {
    return {
      ...this.toSummary(draft, customer, document),
      extractedData: draft.extractedData as unknown as ExtractedRateConfirmationData,
    };
  }
}
