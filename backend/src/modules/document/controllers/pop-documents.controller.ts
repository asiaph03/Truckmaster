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
import { UploadPopDocumentDto } from '../dto/upload-pop-document.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * POP upload against a specific pickup Stop — mirrors
 * PodDocumentsController's exact placement and thin-wrapper pattern (see
 * its own doc comment): no @Roles() guard here, the entity-aware upload
 * permission is enforced inside DocumentService.assertUploadPermission,
 * identical to the POD route's permission check (POP reuses the same
 * Admin/OpsMgr/Dispatcher/Accounting role set — both are STOP-entity
 * uploads).
 */
@Controller('loads/:loadId/stops/:sequence/pop-documents')
@UseGuards(RolesGuard)
export class PopDocumentsController {
  constructor(private readonly documentService: DocumentService) {}

  @Post()
  upload(
    @Param('loadId', ParseUUIDPipe) loadId: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @Body() dto: UploadPopDocumentDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.documentService.initiatePopUpload(
      organizationId,
      loadId,
      sequence,
      dto,
      actingUserId,
    );
  }
}
