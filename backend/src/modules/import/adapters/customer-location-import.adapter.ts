import { Injectable } from '@nestjs/common';
import { CustomerLocationType } from '@prisma/client';
import { CustomerService } from '../../customer/services/customer.service';
import { AddCustomerLocationDto } from '../../customer/dto/add-customer-location.dto';
import { ImportAdapter, ImportBusinessRuleResult } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class CustomerLocationImportAdapter implements ImportAdapter<AddCustomerLocationDto> {
  readonly entityType = 'CUSTOMER_LOCATION' as const;
  readonly parentEntity = 'CUSTOMER' as const;
  readonly parentField = { key: 'customerLegalName', label: 'Customer Legal Name', required: true };
  readonly fields = [
    { key: 'name', label: 'Name', required: true },
    { key: 'addressLine1', label: 'Address Line 1', required: true },
    { key: 'city', label: 'City', required: true },
    { key: 'state', label: 'State', required: true },
    { key: 'zip', label: 'Zip', required: true },
    { key: 'country', label: 'Country', required: false },
    {
      key: 'locationType',
      label: `Location Type (${Object.values(CustomerLocationType).join('/')})`,
      required: true,
    },
    { key: 'contactName', label: 'Contact Name', required: false },
    { key: 'contactPhone', label: 'Contact Phone', required: false },
    { key: 'contactEmail', label: 'Contact Email', required: false },
    { key: 'operatingHours', label: 'Operating Hours', required: false },
    { key: 'appointmentRequirements', label: 'Appointment Requirements', required: false },
    { key: 'notes', label: 'Notes', required: false },
  ];

  constructor(private readonly customerService: CustomerService) {}

  mapRow(mapped: Record<string, string>) {
    return validateRowDto(AddCustomerLocationDto, {
      name: blankToUndefined(mapped.name),
      addressLine1: blankToUndefined(mapped.addressLine1),
      city: blankToUndefined(mapped.city),
      state: blankToUndefined(mapped.state),
      zip: blankToUndefined(mapped.zip),
      country: blankToUndefined(mapped.country),
      locationType: blankToUndefined(mapped.locationType)?.toUpperCase(),
      contactName: blankToUndefined(mapped.contactName),
      contactPhone: blankToUndefined(mapped.contactPhone),
      contactEmail: blankToUndefined(mapped.contactEmail),
      operatingHours: blankToUndefined(mapped.operatingHours),
      appointmentRequirements: blankToUndefined(mapped.appointmentRequirements),
      notes: blankToUndefined(mapped.notes),
    });
  }

  async checkBusinessRules(): Promise<ImportBusinessRuleResult> {
    return { errors: [] };
  }

  async commit(
    organizationId: string,
    dto: AddCustomerLocationDto,
    actingUserId: string,
    parentId: string | undefined,
  ): Promise<{ entityId: string }> {
    const location = await this.customerService.addLocation(
      organizationId,
      parentId!,
      dto,
      actingUserId,
    );
    return { entityId: location.id };
  }
}
