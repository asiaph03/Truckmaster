import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import {
  documentTypesApi,
  documentsApi,
  isDocumentConsumable,
  type DocumentEntityType,
  type DocumentSearchFilters,
  type DocumentSearchResultRow,
  type DocumentSearchSort,
} from '../../api';
import { ApiError } from '../../api/errors';
import { Badge, Button, ConfirmDialog, DataTable, type DataTableSort } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import { useSessionStore } from '../../auth/session-store';
import '../shared/ListPage.css';
import './DocumentCenterPage.css';

const ENTITY_TYPE_OPTIONS: { value: DocumentEntityType | ''; label: string }[] = [
  { value: '', label: 'All entity types' },
  { value: 'LOAD', label: 'Load' },
  { value: 'STOP', label: 'Stop (POD)' },
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'CARRIER', label: 'Carrier' },
  { value: 'DRIVER', label: 'Driver' },
  { value: 'TRUCK', label: 'Truck' },
  { value: 'TRAILER', label: 'Trailer' },
  { value: 'INVOICE', label: 'Invoice' },
  { value: 'CARRIER_PAYMENT', label: 'Carrier Payment' },
];

/** STOP maps to "Load" since the backend resolves a POD document to its parent Load's number and link — same displayed identity. */
const ENTITY_TYPE_LABELS: Record<DocumentEntityType, string> = {
  LOAD: 'Load',
  STOP: 'Load',
  CUSTOMER: 'Customer',
  CARRIER: 'Carrier',
  DRIVER: 'Driver',
  TRUCK: 'Truck',
  TRAILER: 'Trailer',
  INVOICE: 'Invoice',
  CARRIER_PAYMENT: 'Carrier Payment',
};

const SCAN_STATUS_OPTIONS = [
  { value: '', label: 'All scan statuses' },
  { value: 'PENDING', label: 'Scanning' },
  { value: 'CLEAN', label: 'Clean' },
  { value: 'INFECTED', label: 'Infected' },
  { value: 'SCAN_FAILED', label: 'Scan Failed' },
];

const REVIEW_STATUS_OPTIONS = [
  { value: '', label: 'All review statuses' },
  { value: 'NOT_APPLICABLE', label: 'Not Applicable' },
  { value: 'PENDING_REVIEW', label: 'Pending Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
];

const GENERATION_STATUS_OPTIONS = [
  { value: '', label: 'All generation statuses' },
  { value: 'PENDING', label: 'Generating' },
  { value: 'COMPLETE', label: 'Complete' },
  { value: 'FAILED', label: 'Generation Failed' },
];

/** Only these 3 columns are sortable, matching Load Search's own restrictive `SORTABLE_KEYS` precedent (no single ORDER BY spans the heterogeneous Owning Entity column). */
const SORTABLE_KEYS: DocumentSearchSort[] = ['fileName', 'documentType', 'uploadedAt'];

function ScanStatusCell({
  row,
  onDownload,
}: {
  row: DocumentSearchResultRow;
  onDownload: (documentId: string) => void;
}) {
  // Mirrors DocumentsTab.tsx's ScanStatusCell precedence exactly —
  // system-generated documents carry their own generationStatus, which
  // always takes precedence over scanStatus (CLEAN from the moment the
  // row is created, since generated PDFs skip malware scanning).
  if (row.generationStatus === 'PENDING') return <Badge label="Generating…" color="neutral" />;
  if (row.generationStatus === 'FAILED') {
    return (
      <Badge
        label="Generation Failed"
        color={getStatusBadgeColor('Document.generationStatus', 'FAILED') ?? 'danger'}
      />
    );
  }
  // CLEAN and SCAN_FAILED are both consumable (approved operational
  // policy — a failed scan attempt doesn't block usage, only an actual
  // INFECTED detection does). A SCAN_FAILED document still shows its own
  // badge alongside Download so the scan outcome stays visible, never
  // silently presented as if it were CLEAN.
  if (isDocumentConsumable(row.scanStatus)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Button variant="tertiary" size="sm" onClick={() => onDownload(row.id)}>
          Download
        </Button>
        {row.scanStatus === 'SCAN_FAILED' ? (
          <Badge
            label="Scan Failed"
            color={getStatusBadgeColor('Document.scanStatus', 'SCAN_FAILED') ?? 'danger'}
          />
        ) : null}
      </div>
    );
  }
  if (row.scanStatus === 'PENDING') return <Badge label="Scanning…" color="neutral" />;
  return (
    <Badge
      label="Blocked (Infected)"
      color={getStatusBadgeColor('Document.scanStatus', 'INFECTED') ?? 'danger'}
    />
  );
}

/**
 * Approved Document Center implementation plan — a dedicated cross-entity
 * search screen backed by `GET /documents/search` /
 * `GET /documents/search/export`, structured directly on `LoadSearchPage`'s
 * precedent (filters → DataTable → CSV export). Per the locked decisions:
 * a single "Owning Entity" column with an explicit link (never a whole-row
 * click, never a second related-entity column), no invented actions —
 * Download reuses `DocumentsTab`'s exact scan-gated cell, Review reuses
 * `ComplianceTab`'s exact Approve/Reject/self-review-block pattern, scoped
 * to `entityType === 'CARRIER'` (the only entity type Review ever applied
 * to before this screen existed).
 */
export function DocumentCenterPage() {
  const { can } = usePermissions();
  const userId = useSessionStore((s) => s.userId);
  const queryClient = useQueryClient();
  const toast = useToast();

  const [q, setQ] = useState('');
  const [entityType, setEntityType] = useState<DocumentEntityType | ''>('');
  const [documentTypeId, setDocumentTypeId] = useState('');
  const [scanStatus, setScanStatus] = useState('');
  const [reviewStatus, setReviewStatus] = useState('');
  const [generationStatus, setGenerationStatus] = useState('');
  const [uploadedFrom, setUploadedFrom] = useState('');
  const [uploadedTo, setUploadedTo] = useState('');
  const [sort, setSort] = useState<DataTableSort | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [exporting, setExporting] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);

  const filters: DocumentSearchFilters = useMemo(
    () => ({
      q: q.trim() || undefined,
      entityType: entityType || undefined,
      documentTypeId: documentTypeId || undefined,
      scanStatus: (scanStatus || undefined) as DocumentSearchFilters['scanStatus'],
      reviewStatus: (reviewStatus || undefined) as DocumentSearchFilters['reviewStatus'],
      generationStatus: (generationStatus ||
        undefined) as DocumentSearchFilters['generationStatus'],
      uploadedFrom: uploadedFrom || undefined,
      uploadedTo: uploadedTo || undefined,
      sort: sort?.key as DocumentSearchSort | undefined,
      sortDirection: sort?.direction,
      page,
      pageSize,
    }),
    [
      q,
      entityType,
      documentTypeId,
      scanStatus,
      reviewStatus,
      generationStatus,
      uploadedFrom,
      uploadedTo,
      sort,
      page,
      pageSize,
    ],
  );

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['documents-search', filters],
    queryFn: () => documentsApi.search(filters),
  });
  const { data: documentTypes = [] } = useQuery({
    queryKey: ['document-types'],
    queryFn: () => documentTypesApi.list(),
  });

  function resetToPage1<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
    };
  }
  const onQChange = resetToPage1(setQ);
  const onEntityTypeChange = resetToPage1(setEntityType);
  const onDocumentTypeChange = resetToPage1(setDocumentTypeId);
  const onScanStatusChange = resetToPage1(setScanStatus);
  const onReviewStatusChange = resetToPage1(setReviewStatus);
  const onGenerationStatusChange = resetToPage1(setGenerationStatus);
  const onUploadedFromChange = resetToPage1(setUploadedFrom);
  const onUploadedToChange = resetToPage1(setUploadedTo);

  function handleSortChange(key: string) {
    if (!SORTABLE_KEYS.includes(key as DocumentSearchSort)) return;
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
    setPage(1);
  }

  async function handleExport() {
    setExporting(true);
    try {
      await documentsApi.exportSearchCsv(filters);
    } catch {
      toast.danger('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  async function handleDownload(documentId: string) {
    try {
      const { url } = await documentsApi.getDownloadUrl(documentId);
      window.open(url, '_blank', 'noopener');
    } catch {
      toast.danger('Could not get a download link.');
    }
  }

  async function handleApprove(documentId: string) {
    try {
      await documentsApi.review(documentId, { decision: 'APPROVED' });
      toast.success('Document approved.');
      await refetch();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function handleReject(reason?: string) {
    if (!rejecting) return;
    try {
      await documentsApi.review(rejecting, { decision: 'REJECTED', rejectionReason: reason });
      toast.success('Document rejected.');
      setRejecting(null);
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['documents', 'pending-review'] });
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Document Center</h1>
        <Button variant="secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      <div className="list-page-toolbar">
        <div className="list-page-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            placeholder="Search File Name, Document Type, or Owning Entity…"
            value={q}
            onChange={(e) => onQChange(e.target.value)}
          />
        </div>
        <select
          className="field-select list-page-filter"
          value={entityType}
          onChange={(e) => onEntityTypeChange(e.target.value as DocumentEntityType | '')}
        >
          {ENTITY_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={documentTypeId}
          onChange={(e) => onDocumentTypeChange(e.target.value)}
        >
          <option value="">All document types</option>
          {documentTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={scanStatus}
          onChange={(e) => onScanStatusChange(e.target.value)}
        >
          {SCAN_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="list-page-toolbar">
        <select
          className="field-select list-page-filter"
          value={reviewStatus}
          onChange={(e) => onReviewStatusChange(e.target.value)}
        >
          {REVIEW_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={generationStatus}
          onChange={(e) => onGenerationStatusChange(e.target.value)}
        >
          {GENERATION_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="document-center-date-filter">
          Uploaded from
          <input
            type="date"
            value={uploadedFrom}
            onChange={(e) => onUploadedFromChange(e.target.value)}
          />
        </label>
        <label className="document-center-date-filter">
          to
          <input
            type="date"
            value={uploadedTo}
            onChange={(e) => onUploadedToChange(e.target.value)}
          />
        </label>
      </div>

      <DataTable
        loading={isLoading}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No documents match your filters."
        sort={sort}
        onSortChange={handleSortChange}
        pagination={{
          page,
          pageSize,
          total: data?.total ?? 0,
          onPageChange: setPage,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setPage(1);
          },
        }}
        columns={[
          { key: 'fileName', header: 'File Name', render: (r) => r.fileName },
          { key: 'documentType', header: 'Document Type', render: (r) => r.documentTypeLabel },
          {
            key: 'entity',
            header: 'Owning Entity',
            render: (r) =>
              r.entityLinkPath ? (
                <Link to={r.entityLinkPath}>
                  {ENTITY_TYPE_LABELS[r.entityType]}: {r.entityLabel}
                </Link>
              ) : (
                `${ENTITY_TYPE_LABELS[r.entityType]}: ${r.entityLabel}`
              ),
          },
          {
            key: 'reviewStatus',
            header: 'Review Status',
            render: (r) =>
              r.reviewStatus && r.reviewStatus !== 'NOT_APPLICABLE' ? (
                <Badge
                  label={r.reviewStatus.replace('_', ' ')}
                  color={getStatusBadgeColor('Document.reviewStatus', r.reviewStatus) ?? 'neutral'}
                />
              ) : (
                '—'
              ),
          },
          {
            key: 'uploaded',
            header: 'Uploaded By/At',
            render: (r) => `${r.uploadedByName} — ${new Date(r.uploadedAt).toLocaleString()}`,
          },
        ]}
        rowActions={(r) => {
          const isOwnUpload = r.uploadedByUserId === userId;
          const canReview =
            r.entityType === 'CARRIER' &&
            r.reviewStatus === 'PENDING_REVIEW' &&
            can('reviewComplianceDocuments');
          return (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <ScanStatusCell row={r} onDownload={handleDownload} />
              {canReview ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isOwnUpload}
                    title={isOwnUpload ? 'You cannot review a document you uploaded' : undefined}
                    onClick={() => handleApprove(r.id)}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isOwnUpload}
                    title={isOwnUpload ? 'You cannot review a document you uploaded' : undefined}
                    onClick={() => setRejecting(r.id)}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
            </div>
          );
        }}
      />

      <ConfirmDialog
        open={rejecting !== null}
        title="Reject Document"
        message="This will mark the document as rejected."
        confirmLabel="Reject Document"
        confirmVariant="destructive"
        requireReason
        onCancel={() => setRejecting(null)}
        onConfirm={handleReject}
      />
    </div>
  );
}
