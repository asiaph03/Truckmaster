import { Injectable } from '@nestjs/common';
import { Customer, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { UpdateCustomerDto } from '../dto/update-customer.dto';
import { ChangeCustomerStatusDto } from '../dto/change-customer-status.dto';
import { AddCustomerContactDto } from '../dto/add-customer-contact.dto';
import { AddCustomerLocationDto } from '../dto/add-customer-location.dto';
import { AddCustomerRateAgreementDto } from '../dto/add-customer-rate-agreement.dto';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../../common/errors/app-error';

export interface DuplicateMatch {
  customerId: string;
  legalName: string;
  matchedOn: ('legalName' | 'billingAddress' | 'primaryContactEmail')[];
}

export type CustomerDuplicateCandidate = Customer & {
  contacts: { email: string | null }[];
};

/** Case/punctuation-insensitive comparison (Workflow 2 §2.2). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findById(organizationId: string, id: string) {
    const customer = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.customer.findFirst({
        where: { id, organizationId },
        include: { contacts: true, locations: true, rateAgreements: true },
      }),
    );
    if (!customer) throw new NotFoundError('Customer not found.');
    return customer;
  }

  list(organizationId: string, filters: { status?: string; search?: string } = {}) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.customer.findMany({
        where: {
          organizationId,
          ...(filters.status ? { status: filters.status as Customer['status'] } : {}),
          ...(filters.search
            ? { legalName: { contains: filters.search, mode: 'insensitive' as const } }
            : {}),
        },
        orderBy: { legalName: 'asc' },
      }),
    );
  }

  /**
   * Workflow 2 §2.2 — duplicate detection scan. Fetches the org's existing
   * customers and compares in application code rather than a fuzzy-match
   * SQL query — a straightforward approach appropriate at the PRD's locked
   * target scale (100-500 loads/day per org, §1.3's "no premature
   * optimization" principle, mirrored from the Global Search resolution).
   */
  private async findDuplicates(
    tx: Prisma.TransactionClient,
    organizationId: string,
    dto: CreateCustomerDto,
  ): Promise<DuplicateMatch[]> {
    const candidates = await this.fetchDuplicateCandidates(tx, organizationId);
    return this.matchDuplicates(dto, candidates);
  }

  /**
   * Bulk Import (approved technical design, Decision 9/12) — the candidate
   * fetch, exposed publicly so a batch-import worker can preload it ONCE
   * per batch instead of once per row (findDuplicates()'s per-call
   * `findMany` is a full-table fetch, not an indexed lookup — cheap once,
   * expensive 5,000 times). Manual create() is untouched: it still calls
   * the private findDuplicates() above, which composes this fetch with
   * matchDuplicates() exactly as it always has.
   */
  async fetchDuplicateCandidates(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<CustomerDuplicateCandidate[]> {
    return tx.customer.findMany({ where: { organizationId }, include: { contacts: true } });
  }

  /** Same fetch, in its own transaction — for callers (Bulk Import) outside an existing `withTenantTransaction`. */
  async fetchDuplicateCandidatesForOrg(
    organizationId: string,
  ): Promise<CustomerDuplicateCandidate[]> {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      this.fetchDuplicateCandidates(tx, organizationId),
    );
  }

  /**
   * Bulk Import (approved technical design, Decision 9/12) — the pure
   * comparison extracted verbatim from the loop below, so a batch import's
   * growing in-memory candidate cache (existing DB customers + customers
   * already committed earlier in the same batch) can be matched against
   * without re-implementing the algorithm. Identical logic/semantics to
   * the inline version this replaced.
   */
  matchDuplicates(
    dto: CreateCustomerDto,
    candidates: CustomerDuplicateCandidate[],
  ): DuplicateMatch[] {
    const targetName = normalize(dto.legalName);
    const targetAddress = normalize(
      `${dto.billingAddressLine1} ${dto.billingCity} ${dto.billingState} ${dto.billingZip}`,
    );
    const targetEmail = dto.primaryContactEmail.toLowerCase();

    const matches: DuplicateMatch[] = [];
    for (const candidate of candidates) {
      const matchedOn: DuplicateMatch['matchedOn'] = [];

      if (normalize(candidate.legalName) === targetName) matchedOn.push('legalName');

      const candidateAddress = normalize(
        `${candidate.billingAddressLine1} ${candidate.billingCity} ${candidate.billingState} ${candidate.billingZip}`,
      );
      if (candidateAddress === targetAddress) matchedOn.push('billingAddress');

      const emailPool = [
        candidate.primaryContactEmail.toLowerCase(),
        ...candidate.contacts.map((c) => c.email?.toLowerCase()).filter(Boolean),
      ];
      if (emailPool.includes(targetEmail)) matchedOn.push('primaryContactEmail');

      if (matchedOn.length > 0) {
        matches.push({ customerId: candidate.id, legalName: candidate.legalName, matchedOn });
      }
    }
    return matches;
  }

  /**
   * Workflow 2 §2.1 (creation) + §2.2 (duplicate warning) + §2.3 (missing
   * org payment-terms hard block).
   *
   * `precomputedCandidates` — Bulk Import only (approved technical design,
   * Decision 9/12): when supplied, skips this method's own full-table
   * `findDuplicates()` fetch and matches against the caller's already-
   * fetched, batch-scoped candidate list instead (still via the identical
   * `matchDuplicates()` comparison). Every manual caller omits this
   * argument and gets byte-identical behavior to before this change — this
   * is a pure, opt-in performance hook, not a second duplicate-check
   * implementation.
   */
  async create(
    organizationId: string,
    dto: CreateCustomerDto,
    actingUserId: string,
    precomputedCandidates?: CustomerDuplicateCandidate[],
  ): Promise<Customer> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      // §2.3 — hard precondition, never silently defaulted. Structurally
      // near-impossible under this schema (Organization.defaultPaymentTerms
      // is NOT NULL with a schema-level default set at provisioning,
      // Workflow 1 §1.1), but checked explicitly anyway since the workflow
      // treats this as a real exception path with its own audit event, not
      // a condition safe to assume away.
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      if (!organization.defaultPaymentTerms) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Customer Creation Blocked — Missing Organization Configuration',
          entityType: 'Customer',
          entityId: organizationId,
          actorUserId: actingUserId,
        });
        throw new BusinessRuleError(
          'Your organization is missing a default payment terms setting. Contact your Administrator or support.',
        );
      }

      const duplicates = precomputedCandidates
        ? this.matchDuplicates(dto, precomputedCandidates)
        : await this.findDuplicates(tx, organizationId, dto);
      if (duplicates.length > 0) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Duplicate Warning Shown',
          entityType: 'Customer',
          entityId: organizationId,
          newValue: { candidateLegalName: dto.legalName, matches: duplicates },
          actorType: 'SYSTEM',
        });

        if (!dto.acknowledgeDuplicates) {
          throw new ConflictError('One or more possible duplicate customers were found.', {
            reasonCode: 'POSSIBLE_DUPLICATE_CUSTOMER',
            matches: duplicates,
          });
        }

        await this.audit.record(tx, {
          organizationId,
          action: 'Duplicate Warning Acknowledged',
          entityType: 'Customer',
          entityId: organizationId,
          newValue: { matches: duplicates },
          actorUserId: actingUserId,
        });
      }

      const paymentTerms = dto.paymentTermsOverride ?? organization.defaultPaymentTerms;
      const paymentTermsSource = dto.paymentTermsOverride ? 'OVERRIDE' : 'INHERITED';

      const customer = await tx.customer.create({
        data: {
          organizationId,
          legalName: dto.legalName,
          billingAddressLine1: dto.billingAddressLine1,
          billingCity: dto.billingCity,
          billingState: dto.billingState,
          billingZip: dto.billingZip,
          billingCountry: dto.billingCountry ?? 'US',
          primaryContactName: dto.primaryContactName,
          primaryContactEmail: dto.primaryContactEmail,
          primaryContactPhone: dto.primaryContactPhone,
          status: 'PROSPECT',
          accountOwnerUserId: dto.accountOwnerUserId ?? null,
          paymentTerms,
          paymentTermsSource,
          createdByUserId: actingUserId,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Customer Created',
        entityType: 'Customer',
        entityId: customer.id,
        newValue: {
          legalName: customer.legalName,
          status: customer.status,
          paymentTerms: customer.paymentTerms,
          paymentTermsSource: customer.paymentTermsSource,
        },
        actorUserId: actingUserId,
      });

      return customer;
    });
  }

  /** Workflow 2 §2.5 — field-level diff audit on every edit. */
  async update(
    organizationId: string,
    id: string,
    dto: UpdateCustomerDto,
    actingUserId: string,
  ): Promise<Customer> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.customer.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Customer not found.');

      const fieldChanges: { field: string; previous: unknown; new: unknown }[] = [];
      for (const [field, newValue] of Object.entries(dto)) {
        if (newValue === undefined) continue;
        const previousValue = (existing as unknown as Record<string, unknown>)[field];
        if (previousValue !== newValue) {
          fieldChanges.push({ field, previous: previousValue, new: newValue });
        }
      }

      const updated = await tx.customer.update({
        where: { id },
        data: {
          ...dto,
          paymentTermsSource: dto.paymentTerms ? 'OVERRIDE' : undefined,
        },
      });

      if (fieldChanges.length > 0) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Customer Updated',
          entityType: 'Customer',
          entityId: id,
          previousValue: { field_changes: fieldChanges },
          actorUserId: actingUserId,
        });
      }

      return updated;
    });
  }

  /** Workflow 2 §2.4 — separate action, no checklist defined at this phase. */
  async changeStatus(
    organizationId: string,
    id: string,
    dto: ChangeCustomerStatusDto,
    actingUserId: string,
  ): Promise<Customer> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.customer.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Customer not found.');

      const updated = await tx.customer.update({ where: { id }, data: { status: dto.status } });

      await this.audit.record(tx, {
        organizationId,
        action: 'Customer Status Changed',
        entityType: 'Customer',
        entityId: id,
        previousValue: { status: existing.status },
        newValue: { status: updated.status },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  async addContact(
    organizationId: string,
    customerId: string,
    dto: AddCustomerContactDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: customerId, organizationId } });
      if (!customer) throw new NotFoundError('Customer not found.');

      const contact = await tx.customerContact.create({
        data: { organizationId, customerId, ...dto, isPrimary: dto.isPrimary ?? false },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Customer Contact Added',
        entityType: 'Customer',
        entityId: customerId,
        newValue: { name: contact.name, role: contact.role },
        actorUserId: actingUserId,
      });

      return contact;
    });
  }

  async addLocation(
    organizationId: string,
    customerId: string,
    dto: AddCustomerLocationDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: customerId, organizationId } });
      if (!customer) throw new NotFoundError('Customer not found.');

      const location = await tx.customerLocation.create({
        data: { organizationId, customerId, ...dto, country: dto.country ?? 'US' },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Customer Location Added',
        entityType: 'Customer',
        entityId: customerId,
        newValue: { name: location.name, locationType: location.locationType },
        actorUserId: actingUserId,
      });

      return location;
    });
  }

  async addRateAgreement(
    organizationId: string,
    customerId: string,
    dto: AddCustomerRateAgreementDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: customerId, organizationId } });
      if (!customer) throw new NotFoundError('Customer not found.');

      if (dto.expirationDate && dto.expirationDate <= dto.effectiveDate) {
        throw new BusinessRuleError('Expiration date must be after the effective date.');
      }

      const rateAgreement = await tx.customerRateAgreement.create({
        data: {
          organizationId,
          customerId,
          originCity: dto.originCity,
          originState: dto.originState,
          destinationCity: dto.destinationCity,
          destinationState: dto.destinationState,
          equipmentType: dto.equipmentType,
          rate: dto.rate,
          rateType: dto.rateType,
          effectiveDate: new Date(dto.effectiveDate),
          expirationDate: dto.expirationDate ? new Date(dto.expirationDate) : null,
          fuelSurchargeRules: dto.fuelSurchargeRules,
          notes: dto.notes,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Customer Rate Agreement Added',
        entityType: 'Customer',
        entityId: customerId,
        newValue: {
          originCity: rateAgreement.originCity,
          destinationCity: rateAgreement.destinationCity,
          rate: rateAgreement.rate.toString(),
        },
        actorUserId: actingUserId,
      });

      return rateAgreement;
    });
  }
}
