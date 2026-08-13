import { Injectable } from '@nestjs/common';
import { Carrier } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { CarrierEligibilityService } from './carrier-eligibility.service';
import { CreateCarrierDto } from '../dto/create-carrier.dto';
import { UpdateCarrierDto } from '../dto/update-carrier.dto';
import { AddCarrierContactDto } from '../dto/add-carrier-contact.dto';
import { AddCarrierInsuranceDto } from '../dto/add-carrier-insurance.dto';
import { AddFmcsaVerificationDto } from '../dto/add-fmcsa-verification.dto';
import { AddServiceAreaDto } from '../dto/add-service-area.dto';
import { UpdateFactoringInfoDto } from '../dto/update-factoring-info.dto';
import { AddDriverDto } from '../dto/add-driver.dto';
import { AddTruckDto } from '../dto/add-truck.dto';
import { AddTrailerDto } from '../dto/add-trailer.dto';
import {
  BusinessRuleError,
  ConflictError,
  EligibilityError,
  NotFoundError,
} from '../../../common/errors/app-error';

@Injectable()
export class CarrierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly eligibility: CarrierEligibilityService,
  ) {}

  async findById(organizationId: string, id: string) {
    const carrier = await this.prisma.carrier.findFirst({
      where: { id, organizationId },
      include: {
        contacts: true,
        insuranceRecords: true,
        fmcsaVerifications: { orderBy: { verificationDate: 'desc' } },
        serviceAreas: true,
        factoringInfo: true,
        drivers: true,
        trucks: true,
        trailers: true,
      },
    });
    if (!carrier) throw new NotFoundError('Carrier not found.');
    return carrier;
  }

  list(organizationId: string, filters: { status?: string; assignmentEligible?: boolean } = {}) {
    return this.prisma.carrier.findMany({
      where: {
        organizationId,
        ...(filters.status ? { status: filters.status as Carrier['status'] } : {}),
        ...(filters.assignmentEligible !== undefined
          ? { assignmentEligible: filters.assignmentEligible }
          : {}),
      },
      orderBy: { legalName: 'asc' },
    });
  }

  /** Workflow 3 §3.1 (creation) + §3.2 (MC/DOT hard-block duplicate check). */
  async create(
    organizationId: string,
    dto: CreateCarrierDto,
    actingUserId: string,
  ): Promise<Carrier> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const duplicate = await tx.carrier.findFirst({
        where: {
          organizationId,
          OR: [{ mcNumber: dto.mcNumber }, { dotNumber: dto.dotNumber }],
        },
      });
      if (duplicate) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Carrier Creation Blocked — Duplicate MC/DOT',
          entityType: 'Carrier',
          entityId: duplicate.id,
          newValue: { attemptedMcNumber: dto.mcNumber, attemptedDotNumber: dto.dotNumber },
          actorUserId: actingUserId,
        });
        throw new ConflictError('A carrier with this MC number or DOT number already exists.', {
          existingCarrierId: duplicate.id,
        });
      }

      const carrier = await tx.carrier.create({
        data: {
          organizationId,
          legalName: dto.legalName,
          dba: dto.dba,
          mcNumber: dto.mcNumber,
          dotNumber: dto.dotNumber,
          addressLine1: dto.addressLine1,
          city: dto.city,
          state: dto.state,
          zip: dto.zip,
          primaryContactName: dto.primaryContactName,
          primaryContactPhone: dto.primaryContactPhone,
          primaryContactEmail: dto.primaryContactEmail,
          status: 'PENDING',
          assignmentEligible: false,
          createdByUserId: actingUserId,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Created',
        entityType: 'Carrier',
        entityId: carrier.id,
        newValue: {
          legalName: carrier.legalName,
          mcNumber: carrier.mcNumber,
          dotNumber: carrier.dotNumber,
        },
        actorUserId: actingUserId,
      });

      return carrier;
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateCarrierDto,
    actingUserId: string,
  ): Promise<Carrier> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.carrier.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Carrier not found.');

      const fieldChanges: { field: string; previous: unknown; new: unknown }[] = [];
      for (const [field, newValue] of Object.entries(dto)) {
        if (newValue === undefined) continue;
        const previousValue = (existing as unknown as Record<string, unknown>)[field];
        if (previousValue !== newValue)
          fieldChanges.push({ field, previous: previousValue, new: newValue });
      }

      const updated = await tx.carrier.update({ where: { id }, data: dto });

      if (fieldChanges.length > 0) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Carrier Updated',
          entityType: 'Carrier',
          entityId: id,
          previousValue: { field_changes: fieldChanges },
          actorUserId: actingUserId,
        });
      }

      return updated;
    });
  }

  async addContact(
    organizationId: string,
    carrierId: string,
    dto: AddCarrierContactDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const contact = await tx.carrierContact.create({
        data: { organizationId, carrierId, ...dto, isPrimary: dto.isPrimary ?? false },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Contact Added',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: { name: contact.name, role: contact.role },
        actorUserId: actingUserId,
      });

      return contact;
    });
  }

  /** Workflow 3 §3.6 — structured coverage record, distinct from the supporting COI Document. */
  async addInsurance(
    organizationId: string,
    carrierId: string,
    dto: AddCarrierInsuranceDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      if (new Date(dto.expirationDate) <= new Date(dto.effectiveDate)) {
        throw new BusinessRuleError('Expiration date must be after the effective date.');
      }

      const coiDocument = await tx.document.findFirst({
        where: {
          id: dto.coiDocumentId,
          organizationId,
          entityType: 'CARRIER',
          entityId: carrierId,
        },
      });
      if (!coiDocument) throw new NotFoundError('COI document not found for this carrier.');

      const insurance = await tx.carrierInsurance.create({
        data: {
          organizationId,
          carrierId,
          coverageType: dto.coverageType,
          coverageAmount: dto.coverageAmount,
          insuranceCompany: dto.insuranceCompany,
          agentContact: dto.agentContact,
          effectiveDate: new Date(dto.effectiveDate),
          expirationDate: new Date(dto.expirationDate),
          coiDocumentId: dto.coiDocumentId,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Insurance Added/Updated',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: { coverageType: insurance.coverageType, expirationDate: dto.expirationDate },
        actorUserId: actingUserId,
      });

      await this.eligibility.recalculate(tx, organizationId, carrierId);

      return insurance;
    });
  }

  /** Workflow 3 §3.5 — manual FMCSA/SAFER lookup, recorded. */
  async addFmcsaVerification(
    organizationId: string,
    carrierId: string,
    dto: AddFmcsaVerificationDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const verification = await tx.carrierFmcsaVerification.create({
        data: {
          organizationId,
          carrierId,
          verificationDate: new Date(dto.verificationDate),
          resultStatus: dto.resultStatus,
          verifiedByUserId: actingUserId,
          authorityInfo: dto.authorityInfo,
          notes: dto.notes,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'FMCSA Verification Recorded',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: {
          resultStatus: verification.resultStatus,
          verificationDate: dto.verificationDate,
        },
        actorUserId: actingUserId,
      });

      await this.eligibility.recalculate(tx, organizationId, carrierId);

      return verification;
    });
  }

  /** Decision Log D16 — pure storage/display data, no eligibility impact. */
  async addServiceArea(
    organizationId: string,
    carrierId: string,
    dto: AddServiceAreaDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const serviceArea = await tx.carrierServiceArea.create({
        data: { organizationId, carrierId, ...dto, createdByUserId: actingUserId },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Service Area Added',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: { type: serviceArea.type },
        actorUserId: actingUserId,
      });

      return serviceArea;
    });
  }

  /** Workflow 3 §3.11 — informational only, no eligibility impact. */
  async upsertFactoringInfo(
    organizationId: string,
    carrierId: string,
    dto: UpdateFactoringInfoDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const factoringInfo = await tx.carrierFactoringInfo.upsert({
        where: { carrierId },
        create: { carrierId, organizationId, ...dto },
        update: { ...dto },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Factoring Information Updated',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: {
          usesFactoring: factoringInfo.usesFactoring,
          factoringCompany: factoringInfo.factoringCompany,
        },
        actorUserId: actingUserId,
      });

      return factoringInfo;
    });
  }

  async addDriver(
    organizationId: string,
    carrierId: string,
    dto: AddDriverDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const driver = await tx.driver.create({
        data: { organizationId, carrierId, ...dto, active: true },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Driver Added',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: { firstName: driver.firstName, lastName: driver.lastName },
        actorUserId: actingUserId,
      });

      return driver;
    });
  }

  async addTruck(
    organizationId: string,
    carrierId: string,
    dto: AddTruckDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const truck = await tx.truck.create({
        data: { organizationId, carrierId, ...dto, active: true },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Truck Added',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: { unitNumber: truck.unitNumber, truckType: truck.truckType },
        actorUserId: actingUserId,
      });

      return truck;
    });
  }

  async addTrailer(
    organizationId: string,
    carrierId: string,
    dto: AddTrailerDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const trailer = await tx.trailer.create({
        data: { organizationId, carrierId, ...dto, active: true },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Trailer Added',
        entityType: 'Carrier',
        entityId: carrierId,
        newValue: { unitNumber: trailer.unitNumber, trailerType: trailer.trailerType },
        actorUserId: actingUserId,
      });

      return trailer;
    });
  }

  /**
   * Workflow 3 §3.7 — never automatic; the only path to ACTIVE. See
   * CarrierEligibilityService.checkActivationReadiness for why the
   * pre-activation gate omits the status-related conditions.
   */
  async activate(
    organizationId: string,
    carrierId: string,
    actingUserId: string,
  ): Promise<Carrier> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const carrier = await tx.carrier.findFirst({ where: { id: carrierId, organizationId } });
      if (!carrier) throw new NotFoundError('Carrier not found.');
      if (carrier.status !== 'PENDING') {
        throw new BusinessRuleError('Only a Pending carrier can be activated.');
      }

      const readiness = await this.eligibility.checkActivationReadiness(
        tx,
        organizationId,
        carrierId,
      );
      if (!readiness.eligible) {
        throw new EligibilityError('Cannot activate — one or more requirements are not met.', {
          reasons: readiness.reasons,
        });
      }

      const updated = await tx.carrier.update({
        where: { id: carrierId },
        data: { status: 'ACTIVE' },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Activated',
        entityType: 'Carrier',
        entityId: carrierId,
        previousValue: { status: carrier.status },
        newValue: { status: 'ACTIVE' },
        actorUserId: actingUserId,
      });

      await this.eligibility.recalculate(tx, organizationId, carrierId);

      return updated;
    });
  }
}
