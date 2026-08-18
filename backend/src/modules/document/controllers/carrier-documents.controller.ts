import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { DocumentService } from '../services/document.service';
import { UploadCarrierDocumentDto } from '../dto/upload-carrier-document.dto';
import { ReviewDocumentDto } from '../dto/review-document.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Carriers resource row's document-related
 * convenience routes. Lives in the Document module (not the Carrier
 * module) purely to avoid a circular module dependency — CarrierModule
 * already needs no import from here, and this controller needs
 * DocumentService, which only DocumentModule provides. Both routes are
 * thin wrappers that pre-fill `entityType: 'CARRIER'` and delegate to the
 * exact same DocumentService methods `/documents` uses — one
 * implementation, two entry points (Stage 7 rule 8).
 */
@Controller('carriers/:carrierId/documents')
@UseGuards(RolesGuard)
export class CarrierDocumentsController {
  constructor(private readonly documentService: DocumentService) {}

  @Post()
  upload(
    @Param('carrierId', ParseUUIDPipe) carrierId: string,
    @Body() dto: UploadCarrierDocumentDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.documentService.initiateUpload(
      organizationId,
      { ...dto, entityType: 'CARRIER', entityId: carrierId },
      actingUserId,
    );
  }

  @Post(':docId/review')
  @Roles('COMPLIANCE_REVIEWER')
  @HttpCode(200)
  review(@Param('docId', ParseUUIDPipe) docId: string, @Body() dto: ReviewDocumentDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.documentService.review(organizationId, docId, dto, actingUserId);
  }
}
