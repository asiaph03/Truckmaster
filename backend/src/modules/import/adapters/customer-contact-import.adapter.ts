import { Injectable } from '@nestjs/common';
import { CustomerContactRole } from '@prisma/client';
import { CustomerService } from '../../customer/services/customer.service';
import { AddCustomerContactDto } from '../../customer/dto/add-customer-contact.dto';
import { ImportAdapter, ImportBusinessRuleResult } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class CustomerContactImportAdapter implements ImportAdapter<AddCustomerContactDto> {
  readonly entityType = 'CUSTOMER_CONTACT' as const;
  readonly parentEntity = 'CUSTOMER' as const;
  readonly parentField = { key: 'customerLegalName', label: 'Customer Legal Name', required: true };
  readonly fields = [
    { key: 'name', label: 'Name', required: true },
    {
      key: 'role',
      label: `Role (${Object.values(CustomerContactRole).join('/')})`,
      required: true,
    },
    { key: 'email', label: 'Email', required: false },
    { key: 'phone', label: 'Phone', required: false },
  ];

  constructor(private readonly customerService: CustomerService) {}

  mapRow(mapped: Record<string, string>) {
    return validateRowDto(AddCustomerContactDto, {
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
    dto: AddCustomerContactDto,
    actingUserId: string,
    parentId: string | undefined,
  ): Promise<{ entityId: string }> {
    const contact = await this.customerService.addContact(
      organizationId,
      parentId!,
      dto,
      actingUserId,
    );
    return { entityId: contact.id };
  }
}
