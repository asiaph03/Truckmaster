import { Injectable, Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ImportEntityType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { SpreadsheetService } from '../../../common/spreadsheet/spreadsheet.service';
import { NotFoundError, PermissionError, ValidationError } from '../../../common/errors/app-error';
import { ImportAdapterRegistry } from '../adapters/import-adapter.registry';
import { ParentResolutionService } from '../adapters/parent-resolution';
import { ImportDuplicateCache } from '../adapters/types';
import { CreateImportBatchDto } from '../dto/create-import-batch.dto';
import { SubmitMappingDto } from '../dto/submit-mapping.dto';
import { UpdateImportRowDto } from '../dto/update-import-row.dto';
import {
  IMPORT_COMMIT_QUEUE,
  IMPORT_COMMIT_JOB_OPTIONS,
  IMPORT_MAX_FILE_SIZE_BYTES,
  IMPORT_MAX_ROWS,
  importRolesFor,
} from '../import.constants';

/**
 * Bulk Import (PRD.md §1.4, §6.9, §10.1, §13) orchestration. Approved
 * technical design, Decision 6/7 — request/response contracts are
 * preserved from the approved design with one disclosed deviation:
 * `fileName`/`fileFormat` moved from the confirm-upload step into the
 * create-batch step, because StorageService.getUploadUrl() must bake a
 * fixed Content-Type into the presigned S3 URL at generation time — an
 * existing-code constraint, not a design preference (Decision 13's
 * "stop and report rather than silently redesign" — reported here and in
 * the completion report, not silently changed).
 */
@Injectable()
export class ImportBatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly spreadsheet: SpreadsheetService,
    private readonly adapters: ImportAdapterRegistry,
    private readonly parentResolution: ParentResolutionService,
    @Inject(IMPORT_COMMIT_QUEUE) private readonly commitQueue: Queue,
  ) {}

  private assertRole(entityType: ImportEntityType, roles: string[]): void {
    const required = importRolesFor(entityType);
    if (!required.some((r) => roles.includes(r))) {
      throw new PermissionError(`This action requires one of: ${required.join(', ')}.`);
    }
  }

  private contentTypeFor(fileFormat: 'CSV' | 'XLSX'): string {
    return fileFormat === 'CSV'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  async create(
    organizationId: string,
    dto: CreateImportBatchDto,
    actingUserId: string,
    actingRoles: string[],
  ) {
    this.assertRole(dto.entityType, actingRoles);

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          organizationId,
          entityType: dto.entityType,
          status: 'UPLOADED',
          fileName: dto.fileName,
          fileFormat: dto.fileFormat,
          storageKey: '',
          createdByUserId: actingUserId,
        },
      });
      const storageKey = this.storage.buildImportKey(organizationId, batch.id);
      const updated = await tx.importBatch.update({
        where: { id: batch.id },
        data: { storageKey },
      });

      const uploadUrl = await this.storage.getUploadUrl(
        storageKey,
        this.contentTypeFor(dto.fileFormat),
      );

      await this.audit.record(tx, {
        organizationId,
        action: 'Import Batch Created',
        entityType: 'ImportBatch',
        entityId: batch.id,
        newValue: {
          entityType: dto.entityType,
          fileName: dto.fileName,
          fileFormat: dto.fileFormat,
        },
        actorUserId: actingUserId,
      });

      return { importBatch: updated, uploadUrl };
    });
  }

  async confirmUpload(organizationId: string, id: string, actingRoles: string[]) {
    const batch = await this.getOwnedBatch(organizationId, id);
    this.assertRole(batch.entityType, actingRoles);
    if (batch.status !== 'UPLOADED') {
      throw new ValidationError(`Cannot confirm upload for a batch in status ${batch.status}.`);
    }

    const bytes = await this.storage.getObject(batch.storageKey);
    if (bytes.byteLength > IMPORT_MAX_FILE_SIZE_BYTES) {
      throw new ValidationError(
        `File exceeds the maximum allowed size of ${IMPORT_MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`,
      );
    }

    const parsed =
      batch.fileFormat === 'CSV'
        ? this.spreadsheet.parseCsv(bytes)
        : await this.spreadsheet.parseXlsx(bytes);

    if (parsed.rows.length > IMPORT_MAX_ROWS) {
      throw new ValidationError(
        `File has ${parsed.rows.length} rows, exceeding the maximum of ${IMPORT_MAX_ROWS}.`,
      );
    }

    const adapter = this.adapters.get(batch.entityType);
    const targetFields = adapter.parentField
      ? [adapter.parentField, ...adapter.fields]
      : adapter.fields;
    const suggestedMapping = this.suggestMapping(parsed.headers, targetFields);

    await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.importBatch.update({
        where: { id },
        data: { status: 'MAPPING', totalRows: parsed.rows.length },
      }),
    );

    return { headers: parsed.headers, suggestedMapping, targetFields };
  }

  private suggestMapping(
    headers: string[],
    targetFields: { key: string; label: string }[],
  ): Record<string, string | null> {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const mapping: Record<string, string | null> = {};
    for (const header of headers) {
      const normalizedHeader = normalize(header);
      const match = targetFields.find(
        (f) => normalize(f.key) === normalizedHeader || normalize(f.label) === normalizedHeader,
      );
      mapping[header] = match?.key ?? null;
    }
    return mapping;
  }

  async submitMapping(
    organizationId: string,
    id: string,
    dto: SubmitMappingDto,
    actingRoles: string[],
  ) {
    const batch = await this.getOwnedBatch(organizationId, id);
    this.assertRole(batch.entityType, actingRoles);
    if (batch.status !== 'MAPPING') {
      throw new ValidationError(`Cannot submit mapping for a batch in status ${batch.status}.`);
    }

    const adapter = this.adapters.get(batch.entityType);
    const mappedTargetKeys = new Set(
      Object.values(dto.columnMapping).filter((v): v is string => !!v),
    );
    const missingRequired = adapter.fields.filter(
      (f) => f.required && !mappedTargetKeys.has(f.key),
    );
    if (adapter.parentField && !mappedTargetKeys.has(adapter.parentField.key)) {
      missingRequired.push(adapter.parentField);
    }
    if (missingRequired.length > 0) {
      throw new ValidationError(
        `The following required fields are not mapped to a column: ${missingRequired.map((f) => f.label).join(', ')}.`,
      );
    }

    const bytes = await this.storage.getObject(batch.storageKey);
    const parsed =
      batch.fileFormat === 'CSV'
        ? this.spreadsheet.parseCsv(bytes)
        : await this.spreadsheet.parseXlsx(bytes);

    // sourceHeader -> targetKey lookup, inverted for per-row application.
    const cache: ImportDuplicateCache = {};
    const rowsToCreate: {
      organizationId: string;
      importBatchId: string;
      rowNumber: number;
      rawData: Record<string, string>;
      mappedData: Record<string, unknown>;
      status: 'VALID' | 'INVALID';
      errors: string[] | null;
      duplicateWarning: unknown[] | null;
    }[] = [];

    let validCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < parsed.rows.length; i++) {
      const rawRow = parsed.rows[i];
      const mapped: Record<string, string> = {};
      for (const [sourceHeader, targetKey] of Object.entries(dto.columnMapping)) {
        if (targetKey) mapped[targetKey] = rawRow[sourceHeader] ?? '';
      }

      const errors: string[] = [];
      let parentLegalName: string | undefined;
      let parentOk = true;

      if (adapter.parentField) {
        parentLegalName = mapped[adapter.parentField.key];
        const result = await this.parentResolution.resolveByLegalName(
          organizationId,
          adapter.parentEntity!,
          parentLegalName,
        );
        if ('error' in result) {
          errors.push(result.error);
          parentOk = false;
        }
      }

      const mapResult = await adapter.mapRow(mapped);
      if (mapResult.errors.length > 0) errors.push(...mapResult.errors);

      let duplicateWarning: unknown[] | undefined;
      if (parentOk && mapResult.dto && errors.length === 0) {
        const businessResult = await adapter.checkBusinessRules(
          organizationId,
          mapResult.dto,
          cache,
        );
        if (businessResult.errors.length > 0) errors.push(...businessResult.errors);
        duplicateWarning = businessResult.duplicateWarning;
      }

      const isValid = errors.length === 0;
      const mappedDataToStore: Record<string, unknown> = {
        ...(mapResult.dto ?? mapped),
        ...(parentLegalName !== undefined ? { __parentLegalName: parentLegalName } : {}),
      };

      rowsToCreate.push({
        organizationId,
        importBatchId: id,
        rowNumber: i + 1,
        rawData: rawRow,
        mappedData: mappedDataToStore,
        status: isValid ? 'VALID' : 'INVALID',
        errors: errors.length > 0 ? errors : null,
        duplicateWarning: duplicateWarning ?? null,
      });

      if (isValid) validCount++;
      else invalidCount++;
    }

    await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      await tx.importBatchRow.deleteMany({ where: { importBatchId: id } });
      if (rowsToCreate.length > 0) {
        await tx.importBatchRow.createMany({
          data: rowsToCreate as unknown as Prisma.ImportBatchRowCreateManyInput[],
        });
      }
      await tx.importBatch.update({
        where: { id },
        data: {
          status: 'VALIDATED',
          columnMapping: dto.columnMapping,
          totalRows: rowsToCreate.length,
          validRowCount: validCount,
          invalidRowCount: invalidCount,
          validatedAt: new Date(),
        },
      });
    });

    return this.getOwnedBatch(organizationId, id);
  }

  async listRows(
    organizationId: string,
    id: string,
    filters: { status?: string },
    pagination: { page: number; pageSize: number },
  ) {
    await this.getOwnedBatch(organizationId, id);
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const where = {
        organizationId,
        importBatchId: id,
        ...(filters.status ? { status: filters.status as never } : {}),
      };
      const [items, total] = await Promise.all([
        tx.importBatchRow.findMany({
          where,
          orderBy: { rowNumber: 'asc' },
          skip: (pagination.page - 1) * pagination.pageSize,
          take: pagination.pageSize,
        }),
        tx.importBatchRow.count({ where }),
      ]);
      return { items, total, page: pagination.page, pageSize: pagination.pageSize };
    });
  }

  async updateRow(
    organizationId: string,
    id: string,
    rowId: string,
    dto: UpdateImportRowDto,
    actingRoles: string[],
  ) {
    const batch = await this.getOwnedBatch(organizationId, id);
    this.assertRole(batch.entityType, actingRoles);
    if (batch.status !== 'VALIDATED' && batch.status !== 'COMPLETE') {
      throw new ValidationError(`Cannot update a row for a batch in status ${batch.status}.`);
    }

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const row = await tx.importBatchRow.findFirst({
        where: { id: rowId, importBatchId: id, organizationId },
      });
      if (!row) throw new NotFoundError('Import batch row not found.');

      // A row previously SKIPPED for lacking acknowledgment (worker,
      // approved Decision 5/6/12) is only skipped provisionally — once
      // acknowledged it must become eligible for the next commit run
      // again. The worker's eligibility query is `status = 'VALID'`
      // (idempotent/resumable by construction), so resetting status here
      // is what makes re-commit actually pick the row back up, rather
      // than leaving it stuck in a terminal state.
      const resetToValid = row.status === 'SKIPPED' && dto.acknowledgeDuplicate;

      return tx.importBatchRow.update({
        where: { id: rowId },
        data: {
          acknowledgeDuplicate: dto.acknowledgeDuplicate,
          ...(resetToValid
            ? { status: 'VALID' as const, errors: Prisma.JsonNull, processedAt: null }
            : {}),
        },
      });
    });
  }

  async commit(organizationId: string, id: string, actingUserId: string, actingRoles: string[]) {
    const batch = await this.getOwnedBatch(organizationId, id);
    this.assertRole(batch.entityType, actingRoles);
    if (batch.status !== 'VALIDATED' && batch.status !== 'COMPLETE') {
      throw new ValidationError(`Cannot commit a batch in status ${batch.status}.`);
    }

    // Atomic conditional transition (compare-and-swap on `status`), not a
    // separate read-then-write — two concurrent commit calls (double-
    // click, a client retry) must not both pass the guard above and each
    // enqueue their own job for the same batch, which would let two
    // worker runs process the same eligible rows concurrently and create
    // duplicate entities. Only the request that actually flips the status
    // gets to enqueue; the loser sees `count === 0` and fails cleanly.
    const updated = await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const result = await tx.importBatch.updateMany({
        where: { id, organizationId, status: { in: ['VALIDATED', 'COMPLETE'] } },
        data: { status: 'IMPORTING' },
      });
      if (result.count === 0) {
        throw new ValidationError(
          'This batch is already being committed (concurrent commit request).',
        );
      }
      await this.audit.record(tx, {
        organizationId,
        action: 'Import Batch Committed',
        entityType: 'ImportBatch',
        entityId: id,
        actorUserId: actingUserId,
      });
      return tx.importBatch.findFirstOrThrow({ where: { id, organizationId } });
    });

    await this.commitQueue.add(
      'commit',
      { importBatchId: id, organizationId },
      IMPORT_COMMIT_JOB_OPTIONS,
    );

    return updated;
  }

  async getById(organizationId: string, id: string) {
    return this.getOwnedBatch(organizationId, id);
  }

  async list(organizationId: string, entityType?: ImportEntityType) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.importBatch.findMany({
        where: { organizationId, ...(entityType ? { entityType } : {}) },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  private async getOwnedBatch(organizationId: string, id: string) {
    const batch = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.importBatch.findFirst({ where: { id, organizationId } }),
    );
    if (!batch) throw new NotFoundError('Import batch not found.');
    return batch;
  }
}
