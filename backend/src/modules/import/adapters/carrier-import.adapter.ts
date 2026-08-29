import { Injectable } from '@nestjs/common';
import { CarrierService } from '../../carrier/services/carrier.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CreateCarrierDto } from '../../carrier/dto/create-carrier.dto';
import { ImportAdapter, ImportBusinessRuleResult } from './types';
import { blankToUndefined, validateRowDto } from './dto-validation';

@Injectable()
export class CarrierImportAdapter implements ImportAdapter<CreateCarrierDto> {
  readonly entityType = 'CARRIER' as const;
  readonly fields = [
    { key: 'legalName', label: 'Legal Name', required: true },
    { key: 'dba', label: 'DBA', required: false },
    { key: 'mcNumber', label: 'MC Number', required: true },
    { key: 'dotNumber', label: 'DOT Number', required: true },
    { key: 'addressLine1', label: 'Address Line 1', required: true },
    { key: 'city', label: 'City', required: true },
    { key: 'state', label: 'State', required: true },
    { key: 'zip', label: 'Zip', required: true },
    { key: 'primaryContactName', label: 'Primary Contact Name', required: true },
    { key: 'primaryContactPhone', label: 'Primary Contact Phone', required: true },
    { key: 'primaryContactEmail', label: 'Primary Contact Email', required: true },
  ];

  constructor(
    private readonly carrierService: CarrierService,
    private readonly prisma: PrismaService,
  ) {}

  mapRow(mapped: Record<string, string>) {
    return validateRowDto(CreateCarrierDto, {
      legalName: blankToUndefined(mapped.legalName),
      dba: blankToUndefined(mapped.dba),
      mcNumber: blankToUndefined(mapped.mcNumber),
      dotNumber: blankToUndefined(mapped.dotNumber),
      addressLine1: blankToUndefined(mapped.addressLine1),
      city: blankToUndefined(mapped.city),
      state: blankToUndefined(mapped.state),
      zip: blankToUndefined(mapped.zip),
      primaryContactName: blankToUndefined(mapped.primaryContactName),
      primaryContactPhone: blankToUndefined(mapped.primaryContactPhone),
      primaryContactEmail: blankToUndefined(mapped.primaryContactEmail),
    });
  }

  /**
   * Carrier duplicates are a hard block with no override (mirrors
   * CarrierService.create()'s own MC/DOT check exactly, DATABASE_DESIGN.md
   * §schema unique constraint) — surfaced as a row-level validation error
   * at Preview time, not just a commit-time failure, so it's visible
   * before the user confirms (approved Decision 4/5). This is an indexed
   * point lookup (`@@unique([organizationId, mcNumber/dotNumber])`), not
   * Customer's full-table scan, so a per-row check here carries none of
   * the O(rows × org-size) cost Decision 9 was concerned with.
   */
  async checkBusinessRules(
    organizationId: string,
    dto: CreateCarrierDto,
  ): Promise<ImportBusinessRuleResult> {
    const duplicate = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.carrier.findFirst({
        where: { organizationId, OR: [{ mcNumber: dto.mcNumber }, { dotNumber: dto.dotNumber }] },
      }),
    );
    if (duplicate) {
      return {
        errors: [
          `A carrier with this MC number or DOT number already exists (${duplicate.legalName}).`,
        ],
      };
    }
    return { errors: [] };
  }

  async commit(
    organizationId: string,
    dto: CreateCarrierDto,
    actingUserId: string,
  ): Promise<{ entityId: string }> {
    const carrier = await this.carrierService.create(organizationId, dto, actingUserId);
    return { entityId: carrier.id };
  }
}
