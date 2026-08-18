import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DocumentService } from '../services/document.service';
import { UploadPodDocumentDto } from '../dto/upload-pod-document.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * Workflow 7 §7.1 — POD upload against a specific delivery Stop. Lives in
 * the Document module (not quote-load), mirroring CarrierDocumentsController's
 * exact placement and thin-wrapper pattern: no @Roles() guard here — the
 * entity-aware upload permission (Admin/OpsMgr/Dispatcher/Accounting,
 * Workflow 7's own Actors table) is enforced inside
 * DocumentService.assertUploadPermission, consistent with how Carrier
 * document upload permission is checked (§2.5 — fine-grained, entity-aware
 * checks belong in the service layer, not the coarse Guard).
 */
@Controller('loads/:loadId/stops/:sequence/pod-documents')
@UseGuards(RolesGuard)
export class PodDocumentsController {
  constructor(private readonly documentService: DocumentService) {}

  @Post()
  upload(
    @Param('loadId', ParseUUIDPipe) loadId: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @Body() dto: UploadPodDocumentDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.documentService.initiatePodUpload(
      organizationId,
      loadId,
      sequence,
      dto,
      actingUserId,
    );
  }
}
