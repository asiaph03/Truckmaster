import { Injectable } from '@nestjs/common';
import { EquipmentType } from '@prisma/client';
import { CarrierService } from '../../carrier/services/carrier.service';
import { AddTruckDto } from '../../carrier/dto/add-truck.dto';
import { ImportAdapter, ImportBusinessRuleResult } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class TruckImportAdapter implements ImportAdapter<AddTruckDto> {
  readonly entityType = 'TRUCK' as const;
  readonly parentEntity = 'CARRIER' as const;
  readonly parentField = { key: 'carrierLegalName', label: 'Carrier Legal Name', required: true };
  readonly fields = [
    { key: 'unitNumber', label: 'Unit Number', required: true },
    {
      key: 'truckType',
      label: `Truck Type (${Object.values(EquipmentType).join('/')})`,
      required: true,
    },
    { key: 'make', label: 'Make', required: false },
    { key: 'model', label: 'Model', required: false },
    { key: 'year', label: 'Year', required: false },
    { key: 'vin', label: 'VIN', required: false },
    { key: 'plate', label: 'Plate', required: false },
    { key: 'notes', label: 'Notes', required: false },
  ];

  constructor(private readonly carrierService: CarrierService) {}

  mapRow(mapped: Record<string, string>) {
    const yearRaw = blankToUndefined(mapped.year);
    return validateRowDto(AddTruckDto, {
      unitNumber: blankToUndefined(mapped.unitNumber),
      truckType: blankToUndefined(mapped.truckType)?.toUpperCase(),
      make: blankToUndefined(mapped.make),
      model: blankToUndefined(mapped.model),
      year: yearRaw === undefined ? undefined : Number(yearRaw),
      vin: blankToUndefined(mapped.vin),
      plate: blankToUndefined(mapped.plate),
      notes: blankToUndefined(mapped.notes),
    });
  }

  async checkBusinessRules(): Promise<ImportBusinessRuleResult> {
    return { errors: [] };
  }

  async commit(
    organizationId: string,
    dto: AddTruckDto,
    actingUserId: string,
    parentId: string | undefined,
  ): Promise<{ entityId: string }> {
    const truck = await this.carrierService.addTruck(organizationId, parentId!, dto, actingUserId);
    return { entityId: truck.id };
  }
}
