import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  importBatchApi,
  IMPORT_ENTITY_LABELS,
  type ImportEntityType,
  type ImportBatch,
  type ImportBatchRow,
  type ImportFieldSpec,
} from '../../api';
import { ApiError } from '../../api/errors';
import {
  Badge,
  Breadcrumb,
  Button,
  DataTable,
  FilterChip,
  Select,
  Stepper,
} from '../../components/ui';
import { ImportFileUploadField } from '../../components/ui/ImportFileUploadField';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/DetailPage.css';
import './ImportWizardPage.css';

const STEPS = [
  { key: 'upload', label: 'Upload' },
  { key: 'mapping', label: 'Map Columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'summary', label: 'Summary' },
];

const CUSTOMER_ENTITY_TYPES: ImportEntityType[] = [
  'CUSTOMER',
  'CUSTOMER_CONTACT',
  'CUSTOMER_LOCATION',
];
const CARRIER_ENTITY_TYPES: ImportEntityType[] = [
  'CARRIER',
  'CARRIER_CONTACT',
  'DRIVER',
  'TRUCK',
  'TRAILER',
];
const ROWS_PAGE_SIZE = 25;
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;

/**
 * Bulk CSV/Excel Import (PRD.md §1.4, §6.9, §10.1, §13). Approved
 * technical design — one shared wizard for all 8 entity types, launched
 * either standalone (`/import`) or entity-scoped from Customer/Carrier
 * list pages via `?entityType=` (approved Decision 7). Preview/Summary
 * page through the backend's `GET /import-batches/:id/rows` rather than
 * loading all rows into React state at once (approved Decision 14).
 *
 * Structured as one file with step-conditional rendering, mirroring
 * `InvoiceBuilderPage.tsx`'s established wizard shape, rather than
 * separate step-component files — the actual codebase precedent for a
 * multi-step flow is a single page, not a directory of step components.
 */
export function ImportWizardPage() {
  const [searchParams] = useSearchParams();
  const preselected = searchParams.get('entityType') as ImportEntityType | null;
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = usePermissions();

  const availableEntityTypes: ImportEntityType[] = [
    ...(can('manageCustomers') ? CUSTOMER_ENTITY_TYPES : []),
    ...(can('manageCarriers') ? CARRIER_ENTITY_TYPES : []),
  ];

  const [entityType, setEntityType] = useState<ImportEntityType | ''>(
    preselected && availableEntityTypes.includes(preselected) ? preselected : '',
  );
  const [step, setStep] = useState<'upload' | 'mapping' | 'preview' | 'summary'>('upload');
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [targetFields, setTargetFields] = useState<ImportFieldSpec[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string | null>>({});
  const [submittingMapping, setSubmittingMapping] = useState(false);
  const [rows, setRows] = useState<ImportBatchRow[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsPage, setRowsPage] = useState(1);
  const [rowStatusFilter, setRowStatusFilter] = useState<'' | 'VALID' | 'INVALID'>('');
  const [rowsLoading, setRowsLoading] = useState(false);
  const [committing, setCommitting] = useState(false);

  async function loadRows(id: string, page: number, status: '' | 'VALID' | 'INVALID') {
    setRowsLoading(true);
    try {
      const result = await importBatchApi.listRows(id, {
        status: status || undefined,
        page,
        pageSize: ROWS_PAGE_SIZE,
      });
      setRows(result.items);
      setRowsTotal(result.total);
      setRowsPage(result.page);
    } finally {
      setRowsLoading(false);
    }
  }

  async function handleUpload(file: File) {
    if (!entityType) return;
    const fileFormat: 'CSV' | 'XLSX' = file.name.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV';
    const { importBatch, uploadUrl } = await importBatchApi.create({
      entityType,
      fileName: file.name,
      fileFormat,
    });
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': fileFormat === 'CSV' ? 'text/csv' : 'application/octet-stream' },
      body: file,
    });
    const confirmResult = await importBatchApi.confirmUpload(importBatch.id);
    setBatch(importBatch);
    setHeaders(confirmResult.headers);
    setTargetFields(confirmResult.targetFields);
    setColumnMapping(confirmResult.suggestedMapping);
    setStep('mapping');
  }

  async function handleSubmitMapping() {
    if (!batch) return;
    setSubmittingMapping(true);
    try {
      const updated = await importBatchApi.submitMapping(batch.id, columnMapping);
      setBatch(updated);
      setRowStatusFilter('');
      await loadRows(updated.id, 1, '');
      setStep('preview');
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Could not validate the file.');
    } finally {
      setSubmittingMapping(false);
    }
  }

  async function handleAcknowledge(rowId: string, acknowledge: boolean) {
    if (!batch) return;
    await importBatchApi.updateRow(batch.id, rowId, acknowledge);
    await loadRows(batch.id, rowsPage, rowStatusFilter);
  }

  async function pollUntilComplete(id: string) {
    for (let i = 0; i < MAX_POLLS; i++) {
      const current = await importBatchApi.getById(id);
      setBatch(current);
      if (current.status === 'COMPLETE' || current.status === 'FAILED') {
        await loadRows(id, 1, '');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async function handleCommit() {
    if (!batch) return;
    setCommitting(true);
    setStep('summary');
    try {
      await importBatchApi.commit(batch.id);
      await pollUntilComplete(batch.id);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Could not start the import.');
    } finally {
      setCommitting(false);
    }
  }

  const previewColumns = targetFields.slice(0, 3).map((f) => ({
    key: f.key,
    header: f.label,
    render: (r: ImportBatchRow) =>
      String((r.mappedData as Record<string, unknown>)[f.key] ?? r.rawData[f.key] ?? '—'),
  }));

  return (
    <div>
      <Breadcrumb items={[{ label: 'Bulk Import' }]} />
      <h1 className="detail-page-title">Bulk Import</h1>
      <Stepper steps={STEPS} currentIndex={STEPS.findIndex((s) => s.key === step)} />

      {step === 'upload' ? (
        <div className="detail-card">
          <h2 className="detail-card-title">Select what to import</h2>
          <Select
            label="Entity Type"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value as ImportEntityType)}
            options={availableEntityTypes.map((t) => ({
              value: t,
              label: IMPORT_ENTITY_LABELS[t],
            }))}
            placeholder="Choose an entity type…"
          />
          {entityType ? (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <ImportFileUploadField label="Choose CSV or Excel File" onUpload={handleUpload} />
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 'mapping' && batch ? (
        <div className="detail-card">
          <h2 className="detail-card-title">Map columns</h2>
          <p>
            Match each column from your file to a field. Fields marked <strong>*</strong> are
            required.
          </p>
          <table className="import-mapping-table">
            <thead>
              <tr>
                <th>File Column</th>
                <th>Maps To</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((header) => (
                <tr key={header}>
                  <td>{header}</td>
                  <td>
                    <select
                      className="field-select"
                      value={columnMapping[header] ?? ''}
                      onChange={(e) =>
                        setColumnMapping((prev) => ({ ...prev, [header]: e.target.value || null }))
                      }
                    >
                      <option value="">Do not import</option>
                      {targetFields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                          {f.required ? ' *' : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button
            style={{ marginTop: 'var(--space-4)' }}
            loading={submittingMapping}
            onClick={handleSubmitMapping}
          >
            Continue
          </Button>
        </div>
      ) : null}

      {step === 'preview' && batch ? (
        <div className="detail-card">
          <h2 className="detail-card-title">Preview</h2>
          <p>
            {batch.validRowCount ?? 0} valid, {batch.invalidRowCount ?? 0} invalid, of{' '}
            {batch.totalRows ?? 0} total rows.
          </p>
          <div className="import-filter-chip-row">
            <FilterChip
              label="All"
              active={rowStatusFilter === ''}
              onClick={() => {
                setRowStatusFilter('');
                loadRows(batch.id, 1, '');
              }}
            />
            <FilterChip
              label="Valid"
              count={batch.validRowCount ?? 0}
              active={rowStatusFilter === 'VALID'}
              onClick={() => {
                setRowStatusFilter('VALID');
                loadRows(batch.id, 1, 'VALID');
              }}
            />
            <FilterChip
              label="Invalid"
              count={batch.invalidRowCount ?? 0}
              active={rowStatusFilter === 'INVALID'}
              onClick={() => {
                setRowStatusFilter('INVALID');
                loadRows(batch.id, 1, 'INVALID');
              }}
            />
          </div>
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            loading={rowsLoading}
            columns={[
              { key: 'rowNumber', header: 'Row', render: (r) => r.rowNumber },
              ...previewColumns,
              {
                key: 'status',
                header: 'Status',
                render: (r) =>
                  r.status === 'INVALID' ? (
                    <Badge label="Invalid" color="danger" />
                  ) : r.duplicateWarning ? (
                    <Badge label="Possible Duplicate" color="warning" />
                  ) : (
                    <Badge label="Valid" color="success" />
                  ),
              },
              {
                key: 'notes',
                header: 'Notes',
                render: (r) =>
                  r.errors ? (
                    r.errors.join('; ')
                  ) : r.duplicateWarning ? (
                    <label className="import-ack-label">
                      <input
                        type="checkbox"
                        checked={r.acknowledgeDuplicate}
                        onChange={(e) => handleAcknowledge(r.id, e.target.checked)}
                      />
                      Import anyway
                    </label>
                  ) : (
                    '—'
                  ),
              },
            ]}
            pagination={{
              page: rowsPage,
              pageSize: ROWS_PAGE_SIZE,
              total: rowsTotal,
              onPageChange: (p) => loadRows(batch.id, p, rowStatusFilter),
              onPageSizeChange: () => {},
            }}
          />
          <Button
            style={{ marginTop: 'var(--space-4)' }}
            loading={committing}
            disabled={(batch.validRowCount ?? 0) === 0}
            onClick={handleCommit}
          >
            Import {batch.validRowCount ?? 0} rows
          </Button>
        </div>
      ) : null}

      {step === 'summary' && batch ? (
        <div className="detail-card">
          <h2 className="detail-card-title">
            {batch.status === 'IMPORTING' ? 'Importing…' : 'Import complete'}
          </h2>
          {batch.status === 'IMPORTING' ? (
            <p>This may take a moment for larger files…</p>
          ) : (
            <>
              <p>
                {batch.importedRowCount ?? 0} imported, {batch.skippedRowCount ?? 0} skipped,{' '}
                {batch.failedRowCount ?? 0} failed.
              </p>
              <DataTable
                rows={rows.filter((r) => r.status === 'FAILED' || r.status === 'SKIPPED')}
                rowKey={(r) => r.id}
                emptyMessage="Every eligible row imported successfully."
                columns={[
                  { key: 'rowNumber', header: 'Row', render: (r) => r.rowNumber },
                  { key: 'status', header: 'Status', render: (r) => r.status },
                  { key: 'errors', header: 'Reason', render: (r) => r.errors?.join('; ') ?? '—' },
                ]}
              />
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
                <Button
                  onClick={() =>
                    navigate(
                      entityType && CUSTOMER_ENTITY_TYPES.includes(entityType)
                        ? '/customers'
                        : '/carriers',
                    )
                  }
                >
                  Done
                </Button>
                <Button variant="secondary" onClick={() => window.location.reload()}>
                  Import Another File
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
