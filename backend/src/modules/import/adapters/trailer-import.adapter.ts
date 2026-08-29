import { Injectable } from '@nestjs/common';
import { EquipmentType } from '@prisma/client';
import { CarrierService } from '../../carrier/services/carrier.service';
import { AddTrailerDto } from '../../carrier/dto/add-trailer.dto';
import { ImportAdapter, ImportBusinessRuleResult } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class TrailerImportAdapter implements ImportAdapter<AddTrailerDto> {
  readonly entityType = 'TRAILER' as const;
  readonly parentEntity = 'CARRIER' as const;
  readonly parentField = { key: 'carrierLegalName', label: 'Carrier Legal Name', required: true };
  readonly fields = [
    { key: 'unitNumber', label: 'Unit Number', required: true },
    {
      key: 'trailerType',
      label: `Trailer Type (${Object.values(EquipmentType).join('/')})`,
      required: true,
    },
    { key: 'vin', label: 'VIN', required: false },
    { key: 'plate', label: 'Plate', required: false },
    { key: 'notes', label: 'Notes', required: false },
  ];

  constructor(private readonly carrierService: CarrierService) {}

  mapRow(mapped: Record<string, string>) {
    return validateRowDto(AddTrailerDto, {
      unitNumber: blankToUndefined(mapped.unitNumber),
      trailerType: blankToUndefined(mapped.trailerType)?.toUpperCase(),
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
    dto: AddTrailerDto,
    actingUserId: string,
    parentId: string | undefined,
  ): Promise<{ entityId: string }> {
    const trailer = await this.carrierService.addTrailer(
      organizationId,
      parentId!,
      dto,
      actingUserId,
    );
    return { entityId: trailer.id };
  }
}
