import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DocumentEntityType, MembershipRoleName } from '@prisma/client';
import { DocumentService } from '../services/document.service';
import {
  DocumentSearchFilters,
  DocumentSearchService,
  DocumentSearchSort,
  DocumentSearchSortDirection,
} from '../services/document-search.service';
import { CreateDocumentDto } from '../dto/create-document.dto';
import { ReviewDocumentDto } from '../dto/review-document.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

function buildDocumentSearchFilters(raw: {
  q?: string;
  entityType?: DocumentEntityType;
  documentTypeId?: string;
  scanStatus?: string;
  reviewStatus?: string;
  generationStatus?: string;
  uploadedFrom?: string;
  uploadedTo?: string;
  sort?: string;
  sortDirection?: string;
}): DocumentSearchFilters {
  return {
    q: raw.q,
    entityType: raw.entityType,
    documentTypeId: raw.documentTypeId,
    scanStatus: raw.scanStatus,
    reviewStatus: raw.reviewStatus,
    generationStatus: raw.generationStatus,
    uploadedFrom: raw.uploadedFrom,
    uploadedTo: raw.uploadedTo,
    sort: raw.sort as DocumentSearchSort | undefined,
    sortDirection: raw.sortDirection as DocumentSearchSortDirection | undefined,
  };
}

function parsePagination(
  pageParam?: string,
  pageSizeParam?: string,
): { page: number; pageSize: number } {
  const page = Number(pageParam);
  const pageSize = Number(pageSizeParam);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 50,
  };
}

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Documents resource row (generic,
 * polymorphic surface). Entity-specific convenience routes (e.g.
 * `POST /carriers/:id/documents`) live on their owning controller and
 * delegate to this same DocumentService — one implementation, two entry
 * points, per Stage 7 rule 8 ("do not create duplicate business rules").
 */
@Controller('documents')
@UseGuards(RolesGuard)
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly documentSearchService: DocumentSearchService,
  ) {}

  @Get()
  list(@Query('entityType') entityType: DocumentEntityType, @Query('entityId') entityId: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.documentService.list(
      organizationId,
      entityType,
      entityId,
      actingUserId,
      actingRoles,
    );
  }

  // Frontend Phase 20 — Document Center. A dedicated cross-entity search
  // endpoint, separate from `list()` above (which is entity-scoped) and
  // from GlobalSearch (deliberately not extended — see the approved
  // design). Must be registered before any `@Get(':id/...')` route so
  // Nest doesn't try to parse "search" as a document id — matches Load
  // Search's own `search` route-ordering precedent.
  @Get('search')
  search(
    @Query('q') q?: string,
    @Query('entityType') entityType?: DocumentEntityType,
    @Query('documentTypeId') documentTypeId?: string,
    @Query('scanStatus') scanStatus?: string,
    @Query('reviewStatus') reviewStatus?: string,
    @Query('generationStatus') generationStatus?: string,
    @Query('uploadedFrom') uploadedFrom?: string,
    @Query('uploadedTo') uploadedTo?: string,
    @Query('sort') sort?: string,
    @Query('sortDirection') sortDirection?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.documentSearchService.search(
      organizationId,
      actingUserId,
      actingRoles,
      buildDocumentSearchFilters({
        q,
        entityType,
        documentTypeId,
        scanStatus,
        reviewStatus,
        generationStatus,
        uploadedFrom,
        uploadedTo,
        sort,
        sortDirection,
      }),
      parsePagination(page, pageSize),
    );
  }

  // Export shares the exact same filter/search params as `search` above,
  // with no page/pageSize — always every matching row, using the identical
  // `buildWhere` so authorization/exclusions can never drift between the
  // two paths. Matches Load Search's export route shape exactly (raw
  // string body + headers, no @Res()/StreamableFile needed).
  @Get('search/export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="document-center-export.csv"')
  exportSearch(
    @Query('q') q?: string,
    @Query('entityType') entityType?: DocumentEntityType,
    @Query('documentTypeId') documentTypeId?: string,
    @Query('scanStatus') scanStatus?: string,
    @Query('reviewStatus') reviewStatus?: string,
    @Query('generationStatus') generationStatus?: string,
    @Query('uploadedFrom') uploadedFrom?: string,
    @Query('uploadedTo') uploadedTo?: string,
    @Query('sort') sort?: string,
    @Query('sortDirection') sortDirection?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.documentSearchService.exportCsv(
      organizationId,
      actingUserId,
      actingRoles,
      buildDocumentSearchFilters({
        q,
        entityType,
        documentTypeId,
        scanStatus,
        reviewStatus,
        generationStatus,
        uploadedFrom,
        uploadedTo,
        sort,
        sortDirection,
      }),
    );
  }

  /**
   * Frontend Phase 5 approved gap-fix — Carrier Compliance Review Queue.
   * Restricted to the same role that can actually act on the results
   * (`review()` below), matching the approved instruction to reuse
   * existing compliance review rules rather than opening this up more
   * broadly.
   */
  @Get('pending-review')
  @Roles('COMPLIANCE_REVIEWER')
  listPendingReview() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.documentService.listPendingReview(organizationId);
  }

  @Post()
  create(@Body() dto: CreateDocumentDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.documentService.initiateUpload(organizationId, dto, actingUserId);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.documentService.confirmUpload(organizationId, id, actingUserId);
  }

  @Get(':id/download-url')
  getDownloadUrl(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.documentService.getDownloadUrl(organizationId, id, actingUserId, actingRoles);
  }

  // Load-Level Documents Delete — permission enforced inside the service
  // (assertUploadPermission's sibling check, same convention as create()
  // above), not via @Roles() here. Deletes the entire document family
  // (every version), not just the one id passed in — see
  // DocumentService.deleteDocumentFamily's own doc comment.
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    await this.documentService.deleteDocumentFamily(organizationId, id, actingUserId);
  }

  @Post(':id/review')
  @Roles('COMPLIANCE_REVIEWER')
  @HttpCode(200)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDocumentDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.documentService.review(organizationId, id, dto, actingUserId);
  }
}
