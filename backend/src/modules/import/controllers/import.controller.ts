import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ImportEntityType } from '@prisma/client';
import { ImportBatchService } from '../services/import-batch.service';
import { CreateImportBatchDto } from '../dto/create-import-batch.dto';
import { SubmitMappingDto } from '../dto/submit-mapping.dto';
import { UpdateImportRowDto } from '../dto/update-import-row.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { ANY_IMPORT_ROLES } from '../import.constants';

function parsePagination(page?: string, pageSize?: string) {
  return {
    page: Math.max(1, Number.parseInt(page ?? '1', 10) || 1),
    pageSize: Math.min(200, Math.max(1, Number.parseInt(pageSize ?? '50', 10) || 50)),
  };
}

/**
 * Bulk Import (PRD.md §1.4, §6.9, §10.1, §13). Approved endpoints exactly
 * (Decision 13), with one disclosed deviation — see ImportBatchService's
 * doc comment. `@Roles(...ANY_IMPORT_ROLES)` is the coarse Guard-level
 * gate; the fine-grained per-entityType check (Customer vs Carrier role
 * sets) happens in the service layer, mirroring the Roles decorator's own
 * documented split between coarse/fine-grained authorization.
 */
@Controller('import-batches')
@UseGuards(RolesGuard)
@Roles(...ANY_IMPORT_ROLES)
export class ImportController {
  constructor(private readonly importBatchService: ImportBatchService) {}

  @Post()
  create(@Body() dto: CreateImportBatchDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const { roles = [] } = RequestContextStore.current();
    return this.importBatchService.create(organizationId, dto, actingUserId, roles);
  }

  @Get()
  list(@Query('entityType') entityType?: ImportEntityType) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.importBatchService.list(organizationId, entityType);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.importBatchService.getById(organizationId, id);
  }

  @Post(':id/confirm-upload')
  confirmUpload(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const { roles = [] } = RequestContextStore.current();
    return this.importBatchService.confirmUpload(organizationId, id, roles);
  }

  @Patch(':id/mapping')
  submitMapping(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitMappingDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const { roles = [] } = RequestContextStore.current();
    return this.importBatchService.submitMapping(organizationId, id, dto, roles);
  }

  @Get(':id/rows')
  listRows(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.importBatchService.listRows(
      organizationId,
      id,
      { status },
      parsePagination(page, pageSize),
    );
  }

  @Patch(':id/rows/:rowId')
  updateRow(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: UpdateImportRowDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const { roles = [] } = RequestContextStore.current();
    return this.importBatchService.updateRow(organizationId, id, rowId, dto, roles);
  }

  @Post(':id/commit')
  commit(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const { roles = [] } = RequestContextStore.current();
    return this.importBatchService.commit(organizationId, id, actingUserId, roles);
  }
}
