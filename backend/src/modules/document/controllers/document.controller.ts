import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DocumentEntityType } from '@prisma/client';
import { DocumentService } from '../services/document.service';
import { CreateDocumentDto } from '../dto/create-document.dto';
import { ReviewDocumentDto } from '../dto/review-document.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

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
  constructor(private readonly documentService: DocumentService) {}

  @Get()
  list(@Query('entityType') entityType: DocumentEntityType, @Query('entityId') entityId: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.documentService.list(organizationId, entityType, entityId);
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
    return this.documentService.getDownloadUrl(organizationId, id);
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
