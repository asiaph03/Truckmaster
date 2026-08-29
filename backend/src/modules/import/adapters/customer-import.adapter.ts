import { Injectable } from '@nestjs/common';
import { CustomerService } from '../../customer/services/customer.service';
import { CreateCustomerDto } from '../../customer/dto/create-customer.dto';
import { ImportAdapter, ImportBusinessRuleResult, ImportDuplicateCache } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class CustomerImportAdapter implements ImportAdapter<CreateCustomerDto> {
  readonly entityType = 'CUSTOMER' as const;
  readonly fields = [
    { key: 'legalName', label: 'Legal Name', required: true },
    { key: 'billingAddressLine1', label: 'Billing Address Line 1', required: true },
    { key: 'billingCity', label: 'Billing City', required: true },
    { key: 'billingState', label: 'Billing State', required: true },
    { key: 'billingZip', label: 'Billing Zip', required: true },
    { key: 'billingCountry', label: 'Billing Country', required: false },
    { key: 'primaryContactName', label: 'Primary Contact Name', required: true },
    { key: 'primaryContactEmail', label: 'Primary Contact Email', required: true },
    { key: 'primaryContactPhone', label: 'Primary Contact Phone', required: true },
  ];

  constructor(private readonly customerService: CustomerService) {}

  mapRow(mapped: Record<string, string>) {
    return validateRowDto(CreateCustomerDto, {
      legalName: blankToUndefined(mapped.legalName),
      billingAddressLine1: blankToUndefined(mapped.billingAddressLine1),
      billingCity: blankToUndefined(mapped.billingCity),
      billingState: blankToUndefined(mapped.billingState),
      billingZip: blankToUndefined(mapped.billingZip),
      billingCountry: blankToUndefined(mapped.billingCountry),
      primaryContactName: blankToUndefined(mapped.primaryContactName),
      primaryContactEmail: blankToUndefined(mapped.primaryContactEmail),
      primaryContactPhone: blankToUndefined(mapped.primaryContactPhone),
    });
  }

  private async ensureCache(organizationId: string, cache: ImportDuplicateCache) {
    if (!cache.customerCandidates) {
      cache.customerCandidates =
        await this.customerService.fetchDuplicateCandidatesForOrg(organizationId);
    }
    return cache.customerCandidates;
  }

  async checkBusinessRules(
    organizationId: string,
    dto: CreateCustomerDto,
    cache: ImportDuplicateCache,
  ): Promise<ImportBusinessRuleResult> {
    const candidates = await this.ensureCache(organizationId, cache);
    const matches = this.customerService.matchDuplicates(dto, candidates);
    return { errors: [], duplicateWarning: matches.length > 0 ? matches : undefined };
  }

  async commit(
    organizationId: string,
    dto: CreateCustomerDto,
    actingUserId: string,
    _parentId: string | undefined,
    acknowledgeDuplicate: boolean,
    cache: ImportDuplicateCache,
  ): Promise<{ entityId: string }> {
    const candidates = await this.ensureCache(organizationId, cache);
    const customer = await this.customerService.create(
      organizationId,
      { ...dto, acknowledgeDuplicates: acknowledgeDuplicate },
      actingUserId,
      candidates,
    );
    // Grow the in-batch cache so later rows in the same batch see this
    // customer as a duplicate candidate too (approved Decision 9/12).
    candidates.push({ ...customer, contacts: [] });
    return { entityId: customer.id };
  }
}
