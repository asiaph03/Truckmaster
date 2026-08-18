import { Injectable } from '@nestjs/common';
import { Load, MembershipRoleName, Prisma, Quote } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { OrganizationSequenceService } from '../../identity/services/organization-sequence.service';
import { RateAgreementMatchingService } from './rate-agreement-matching.service';
import { LoadService } from './load.service';
import { shapeFinancialFields, shapeFinancialFieldsList } from './financial-field-shaping';
import { CreateQuoteDto } from '../dto/create-quote.dto';
import { MarkQuoteLostDto } from '../dto/mark-quote-lost.dto';
import { ConvertQuoteDto } from '../dto/convert-quote.dto';
import {
  BusinessRuleError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';

/** Workflow 4 §4.2 default expiration — now + 7 days. */
function defaultExpirationDate(): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  return date;
}

@Injectable()
export class QuoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: OrganizationSequenceService,
    private readonly rateAgreementMatching: RateAgreementMatchingService,
    private readonly loadService: LoadService,
  ) {}

  async findById(
    organizationId: string,
    id: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ) {
    const quote = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.quote.findFirst({ where: { id, organizationId }, include: { stops: true } }),
    );
    if (!quote) throw new NotFoundError('Quote not found.');
    return shapeFinancialFields(quote, actingRoles, actingUserId);
  }

  async list(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: { status?: string; customerId?: string } = {},
  ) {
    const quotes = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.quote.findMany({
        where: {
          organizationId,
          ...(filters.status ? { status: filters.status as Quote['status'] } : {}),
          ...(filters.customerId ? { customerId: filters.customerId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return shapeFinancialFieldsList(quotes, actingRoles, actingUserId);
  }

  /** Workflow 4 §4.2 — Quote creation. */
  async create(organizationId: string, dto: CreateQuoteDto, actingUserId: string): Promise<Quote> {
    const firstPickup = [...dto.stops]
      .filter((s) => s.stopType === 'PICKUP')
      .sort((a, b) => a.sequence - b.sequence)[0];
    const lastDelivery = [...dto.stops]
      .filter((s) => s.stopType === 'DELIVERY')
      .sort((a, b) => b.sequence - a.sequence)[0];
    if (!firstPickup || !lastDelivery) {
      throw new BusinessRuleError('At least one pickup stop and one delivery stop are required.');
    }

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      // §4.3 — PROSPECT/ACTIVE/INACTIVE all allowed on the Quote path;
      // only BLOCKED is a hard stop. Inactive gets a UI-level warning
      // only — "status checks that pass silently are not separately
      // audited" (§4.3), so no extra audit event for that case here.
      const customer = await tx.customer.findFirst({
        where: { id: dto.customerId, organizationId },
      });
      if (!customer) throw new NotFoundError('Customer not found.');
      if (customer.status === 'BLOCKED') {
        throw new BusinessRuleError('Customer is Blocked — no new Quotes can be created.');
      }

      const { rateAgreementId, rateSource } = await this.rateAgreementMatching.resolveRate(
        tx,
        organizationId,
        dto.customerId,
        firstPickup.addressCity,
        firstPickup.addressState,
        lastDelivery.addressCity,
        lastDelivery.addressState,
        dto.equipmentType,
        dto.customerRate,
      );

      const nextNumber = await this.sequences.getNextNumber(tx, organizationId, 'QUOTE');
      const quoteNumber = this.sequences.format('QUOTE', nextNumber);

      const quote = await tx.quote.create({
        data: {
          organizationId,
          quoteNumber,
          customerId: dto.customerId,
          equipmentType: dto.equipmentType,
          customerRate: dto.customerRate,
          rateSource,
          rateAgreementId,
          status: 'OPEN',
          expirationDate: dto.expirationDate
            ? new Date(dto.expirationDate)
            : defaultExpirationDate(),
          createdByUserId: actingUserId,
          stops: {
            create: dto.stops.map((stop) => ({
              organizationId,
              sequence: stop.sequence,
              stopType: stop.stopType,
              addressCity: stop.addressCity,
              addressState: stop.addressState,
              addressZip: stop.addressZip,
              appointmentNotes: stop.appointmentNotes,
            })),
          },
        },
        include: { stops: true },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Quote Created',
        entityType: 'Quote',
        entityId: quote.id,
        newValue: {
          quoteNumber: quote.quoteNumber,
          customerId: quote.customerId,
          customerRate: quote.customerRate.toString(),
          rateSource: quote.rateSource,
          expirationDate: quote.expirationDate,
        },
        actorUserId: actingUserId,
      });

      return quote;
    });
  }

  /** Workflow 4 §4.6 — explicit Lost, with required reason. */
  async markLost(
    organizationId: string,
    id: string,
    dto: MarkQuoteLostDto,
    actingUserId: string,
  ): Promise<Quote> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const quote = await tx.quote.findFirst({ where: { id, organizationId } });
      if (!quote) throw new NotFoundError('Quote not found.');
      if (quote.status !== 'OPEN') {
        throw new InvalidTransitionError(
          'Only an OPEN Quote can be marked Lost — WON and LOST are both permanently terminal.',
        );
      }

      const updated = await tx.quote.update({
        where: { id },
        data: { status: 'LOST', lossReason: dto.reason },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Quote Marked Lost',
        entityType: 'Quote',
        entityId: id,
        previousValue: { status: 'OPEN' },
        newValue: { status: 'LOST', lossReason: dto.reason },
        reason: dto.reason,
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /**
   * Workflow 4 §4.7 — Quote → Load conversion. Runs Customer Status
   * Validation against the *Booking* column of §4.3 (stricter than the
   * Quote-creation column), carries forward the Quote's stops/equipment/
   * rate-agreement linkage, requires an explicit rate confirmation
   * (ConvertQuoteDto.confirmedCustomerRate — "cannot proceed silently"),
   * and atomically: creates the Load (`booking_source=QUOTE`,
   * `quote_id` set), flips the Quote to WON with `resulting_load_id` set,
   * and — only if the confirmed rate differs from the original quoted
   * rate — records a separate `Rate Changed During Conversion` audit
   * event. `Quote.customerRate` itself is never modified; the confirmed
   * (possibly different) rate lives only on the new Load.
   */
  async convert(
    organizationId: string,
    id: string,
    dto: ConvertQuoteDto,
    actingUserId: string,
  ): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const quote = await tx.quote.findFirst({
        where: { id, organizationId },
        include: { stops: true },
      });
      if (!quote) throw new NotFoundError('Quote not found.');
      if (quote.status !== 'OPEN') {
        throw new InvalidTransitionError(
          'Only an OPEN Quote can be converted to a Booked Load — an already Won or Lost Quote cannot be reopened or reconverted.',
        );
      }

      const customer = await tx.customer.findFirst({
        where: { id: quote.customerId, organizationId },
      });
      if (!customer) throw new NotFoundError('Customer not found.');
      await this.loadService.assertCustomerAllowsBooking(
        tx,
        organizationId,
        customer,
        dto.confirmInactiveCustomerOverride,
        actingUserId,
      );

      const load = await this.loadService.createFromBooking(tx, organizationId, {
        customerId: quote.customerId,
        bookingSource: 'QUOTE',
        quoteId: quote.id,
        equipmentType: quote.equipmentType,
        customerRate: dto.confirmedCustomerRate,
        rateSource: quote.rateSource,
        rateAgreementId: quote.rateAgreementId,
        stops: quote.stops.map((stop) => ({
          sequence: stop.sequence,
          stopType: stop.stopType,
          city: stop.addressCity,
          state: stop.addressState,
          zip: stop.addressZip,
          notes: stop.appointmentNotes ?? undefined,
        })),
        actingUserId,
        auditAction: 'Load Booked From Quote',
      });

      await tx.quote.update({
        where: { id },
        data: { status: 'WON', resultingLoadId: load.id },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Quote Won — Converted to Load',
        entityType: 'Quote',
        entityId: id,
        previousValue: { status: 'OPEN' },
        newValue: { status: 'WON', resultingLoadId: load.id },
        actorType: 'SYSTEM',
      });

      const rateChanged = !quote.customerRate.equals(new Prisma.Decimal(dto.confirmedCustomerRate));
      if (rateChanged) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Rate Changed During Conversion',
          entityType: 'Quote',
          entityId: id,
          previousValue: { customerRate: quote.customerRate.toString() },
          newValue: { customerRate: dto.confirmedCustomerRate },
          actorUserId: actingUserId,
        });
      }

      return load;
    });
  }
}
