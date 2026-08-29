import { Injectable } from '@nestjs/common';
import { CarrierContactRole } from '@prisma/client';
import { CarrierService } from '../../carrier/services/carrier.service';
import { AddCarrierContactDto } from '../../carrier/dto/add-carrier-contact.dto';
import { ImportAdapter, ImportBusinessRuleResult } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class CarrierContactImportAdapter implements ImportAdapter<AddCarrierContactDto> {
  readonly entityType = 'CARRIER_CONTACT' as const;
  readonly parentEntity = 'CARRIER' as const;
  readonly parentField = { key: 'carrierLegalName', label: 'Carrier Legal Name', required: true };
  readonly fields = [
    { key: 'name', label: 'Name', required: true },
    { key: 'role', label: `Role (${Object.values(CarrierContactRole).join('/')})`, required: true },
    { key: 'email', label: 'Email', required: false },
    { key: 'phone', label: 'Phone', required: false },
  ];

  constructor(private readonly carrierService: CarrierService) {}

  mapRow(mapped: Record<string, string>) {
    return validateRowDto(AddCarrierContactDto, {
      name: blankToUndefined(mapped.name),
      role: blankToUndefined(mapped.role)?.toUpperCase(),
      email: blankToUndefined(mapped.email),
      phone: blankToUndefined(mapped.phone),
    });
  }

  async checkBusinessRules(): Promise<ImportBusinessRuleResult> {
    return { errors: [] };
  }

  async commit(
    organizationId: string,
    dto: AddCarrierContactDto,
    actingUserId: string,
    parentId: string | undefined,
  ): Promise<{ entityId: string }> {
    const contact = await this.carrierService.addContact(
      organizationId,
      parentId!,
      dto,
      actingUserId,
    );
    return { entityId: contact.id };
  }
}
