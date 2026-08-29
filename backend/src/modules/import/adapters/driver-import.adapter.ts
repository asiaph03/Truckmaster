import { Injectable } from '@nestjs/common';
import { CarrierService } from '../../carrier/services/carrier.service';
import { AddDriverDto } from '../../carrier/dto/add-driver.dto';
import { ImportAdapter, ImportBusinessRuleResult } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class DriverImportAdapter implements ImportAdapter<AddDriverDto> {
  readonly entityType = 'DRIVER' as const;
  readonly parentEntity = 'CARRIER' as const;
  readonly parentField = { key: 'carrierLegalName', label: 'Carrier Legal Name', required: true };
  readonly fields = [
    { key: 'firstName', label: 'First Name', required: true },
    { key: 'lastName', label: 'Last Name', required: true },
    { key: 'phone', label: 'Phone', required: true },
    { key: 'email', label: 'Email', required: false },
    { key: 'licenseNumber', label: 'License Number', required: false },
    { key: 'notes', label: 'Notes', required: false },
  ];

  constructor(private readonly carrierService: CarrierService) {}

  mapRow(mapped: Record<string, string>) {
    return validateRowDto(AddDriverDto, {
      firstName: blankToUndefined(mapped.firstName),
      lastName: blankToUndefined(mapped.lastName),
      phone: blankToUndefined(mapped.phone),
      email: blankToUndefined(mapped.email),
      licenseNumber: blankToUndefined(mapped.licenseNumber),
      notes: blankToUndefined(mapped.notes),
    });
  }

  async checkBusinessRules(): Promise<ImportBusinessRuleResult> {
    return { errors: [] };
  }

  async commit(
    organizationId: string,
    dto: AddDriverDto,
    actingUserId: string,
    parentId: string | undefined,
  ): Promise<{ entityId: string }> {
    const driver = await this.carrierService.addDriver(
      organizationId,
      parentId!,
      dto,
      actingUserId,
    );
    return { entityId: driver.id };
  }
}
