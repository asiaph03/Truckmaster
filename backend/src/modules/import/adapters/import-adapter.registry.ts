import { Injectable } from '@nestjs/common';
import { ImportEntityType } from '@prisma/client';
import { ImportAdapter } from './types';
import { CustomerImportAdapter } from './customer-import.adapter';
import { CustomerContactImportAdapter } from './customer-contact-import.adapter';
import { CustomerLocationImportAdapter } from './customer-location-import.adapter';
import { CarrierImportAdapter } from './carrier-import.adapter';
import { CarrierContactImportAdapter } from './carrier-contact-import.adapter';
import { DriverImportAdapter } from './driver-import.adapter';
import { TruckImportAdapter } from './truck-import.adapter';
import { TrailerImportAdapter } from './trailer-import.adapter';

@Injectable()
export class ImportAdapterRegistry {
  private readonly adapters: Record<ImportEntityType, ImportAdapter>;

  constructor(
    customer: CustomerImportAdapter,
    customerContact: CustomerContactImportAdapter,
    customerLocation: CustomerLocationImportAdapter,
    carrier: CarrierImportAdapter,
    carrierContact: CarrierContactImportAdapter,
    driver: DriverImportAdapter,
    truck: TruckImportAdapter,
    trailer: TrailerImportAdapter,
  ) {
    // Each concrete adapter is `ImportAdapter<SpecificDto>` — the registry
    // deliberately type-erases to the generic `ImportAdapter` since every
    // caller (validation pipeline, commit worker) treats rows as loosely-
    // typed payloads at runtime already; a DTO class's lack of a string
    // index signature is a structural-typing artifact, not a real
    // incompatibility (mirrors this codebase's existing `as unknown as X`
    // precedent for generic-row-type code, e.g. Reports Library).
    this.adapters = {
      CUSTOMER: customer,
      CUSTOMER_CONTACT: customerContact,
      CUSTOMER_LOCATION: customerLocation,
      CARRIER: carrier,
      CARRIER_CONTACT: carrierContact,
      DRIVER: driver,
      TRUCK: truck,
      TRAILER: trailer,
    } as unknown as Record<ImportEntityType, ImportAdapter>;
  }

  get(entityType: ImportEntityType): ImportAdapter {
    return this.adapters[entityType];
  }
}
