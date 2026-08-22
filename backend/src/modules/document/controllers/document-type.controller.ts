import { Controller, Get, Query } from '@nestjs/common';
import { DocumentTypeCategory } from '@prisma/client';
import { DocumentTypeService } from '../services/document-type.service';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * Frontend Phase 2 gap-fix — see DocumentTypeService for rationale.
 * No `@Roles()` restriction, matching `GET /documents` itself: knowing a
 * type's id/label isn't sensitive, and the actual upload permission is
 * still enforced by `DocumentService.assertUploadPermission`.
 */
@Controller('document-types')
export class DocumentTypeController {
  constructor(private readonly documentTypeService: DocumentTypeService) {}

  @Get()
  list(@Query('category') category?: DocumentTypeCategory) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.documentTypeService.list(organizationId, category);
  }
}
