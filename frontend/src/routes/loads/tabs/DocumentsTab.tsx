import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  documentTypesApi,
  documentsApi,
  isDocumentConsumable,
  type AppDocument,
  type Load,
} from '../../../api';
import { ApiError } from '../../../api/errors';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  FileUploadField,
  Select,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { formatDateShort } from '../loadDerived';
import '../../shared/DetailPage.css';

async function download(documentId: string, toast: ReturnType<typeof useToast>) {
  try {
    const { url } = await documentsApi.getDownloadUrl(documentId);
    window.open(url, '_blank', 'noopener');
  } catch {
    toast.danger('Could not get a download link.');
  }
}

function ScanStatusCell({ doc, toast }: { doc: AppDocument; toast: ReturnType<typeof useToast> }) {
  // Phase 16 — system-generated documents (Rate Confirmation) carry their
  // own generationStatus; a PENDING/FAILED generation always takes
  // precedence over scanStatus (which is CLEAN from the moment the row is
  // created, since generated PDFs skip malware scanning entirely).
  if (doc.generationStatus === 'PENDING') return <Badge label="Generating…" color="neutral" />;
  if (doc.generationStatus === 'FAILED') {
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
  if (isDocumentConsumable(doc.scanStatus)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Button variant="tertiary" size="sm" onClick={() => download(doc.id, toast)}>
          Download
        </Button>
        {doc.scanStatus === 'SCAN_FAILED' ? (
          <Badge
            label="Scan Failed"
            color={getStatusBadgeColor('Document.scanStatus', 'SCAN_FAILED') ?? 'danger'}
          />
        ) : null}
      </div>
    );
  }
  if (doc.scanStatus === 'PENDING') return <Badge label="Scanning…" color="neutral" />;
  return (
    <Badge
      label="Blocked (Infected)"
      color={getStatusBadgeColor('Document.scanStatus', 'INFECTED') ?? 'danger'}
    />
  );
}

/**
 * Load-Level Documents Replace + Delete. Replace reuses the exact same
 * `existingDocumentFamilyId` mechanism already proven by the Carrier
 * Compliance tab and per-Stop POD/POP (`ComplianceTab.tsx`,
 * `StopDocumentRow` below) — same document type, new version, normal
 * malware scanning, never bypassed. Delete removes the entire document
 * family (all versions, not just this one) via `documentsApi.delete`,
 * which the backend guards against an open Load Draft reference with a
 * clean business error rather than a raw FK crash — surfaced here
 * through the exact same `ApiError`/toast pattern every other mutation
 * on this page already uses. Neither action is frontend-permission-gated
 * (matching this table's existing Upload control, which has never had
 * one either) — the backend's `POD_UPLOAD_ROLES` check is the real
 * boundary, as documented on `DocumentService.deleteDocumentFamily`.
 */
function LoadDocumentActionsCell({
  doc,
  load,
  toast,
  onChanged,
  onDeleteRequested,
}: {
  doc: AppDocument;
  load: Load;
  toast: ReturnType<typeof useToast>;
  onChanged: () => void;
  onDeleteRequested: (doc: AppDocument) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <ScanStatusCell doc={doc} toast={toast} />
      <FileUploadField
        label="Replace"
        onUpload={(file) =>
          documentsApi.uploadLoadDocumentAndConfirm(
            {
              entityType: 'LOAD',
              entityId: load.id,
              documentTypeId: doc.documentTypeId,
              existingDocumentFamilyId: doc.documentFamilyId,
            },
            file,
          )
        }
        onCheckScanStatus={(documentId) =>
          documentsApi.checkScanStatus('LOAD', load.id, documentId)
        }
        onComplete={onChanged}
      />
      <Button variant="destructive" size="sm" onClick={() => onDeleteRequested(doc)}>
        Delete
      </Button>
    </div>
  );
}

/**
 * UI_UX_DESIGN.md §5.4.4 Documents tab. Two grouped tables: Load-level
 * documents (generic, `entityType=LOAD`) and Proof of Pickup/Delivery per
 * Stop (`entityType=STOP`) — a pickup Stop gets POP, a delivery Stop gets
 * POD (Workflow 7 §7.1 for POD; POP is the symmetric pickup-side
 * counterpart, document-tracking only, no locked-workflow milestone).
 * These document families never overlap the Load-level table since both
 * POD and POP are only ever uploaded via the per-stop route, excluded
 * from the Load-level type picker below. No review-status UI here
 * (Load-level document types are `NOT_APPLICABLE` for review).
 */
export function DocumentsTab({ load }: { load: Load }) {
  const toast = useToast();
  const [uploadTypeId, setUploadTypeId] = useState('');
  const [deleting, setDeleting] = useState<AppDocument | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const { data: loadDocTypes = [] } = useQuery({
    queryKey: ['document-types', 'LOAD'],
    queryFn: () => documentTypesApi.list('LOAD'),
  });
  const { data: loadDocuments = [], refetch: refetchLoadDocs } = useQuery({
    queryKey: ['documents', 'LOAD', load.id],
    queryFn: () => documentsApi.list('LOAD', load.id),
  });

  async function onConfirmDelete() {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      await documentsApi.delete(deleting.id);
      toast.success(`${deleting.fileName} deleted.`);
      setDeleting(null);
      await refetchLoadDocs();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setIsDeleting(false);
    }
  }

  // POD and POP are each only ever uploaded via their own per-stop route
  // below — never through this generic Load-level picker.
  const uploadableTypes = loadDocTypes.filter((t) => t.code !== 'POD' && t.code !== 'POP');
  const currentDocs = loadDocuments.filter((d) => d.isCurrentVersion);

  // Strictly stopType-driven — never sequence/index/first/last — so any
  // number of pickups and deliveries, in any order, each get their own
  // row with the correct upload control. A Stop with type OTHER has no
  // defined document type here and is intentionally omitted.
  const podPopStops = [...load.stops]
    .filter((s) => s.stopType === 'PICKUP' || s.stopType === 'DELIVERY')
    .sort((a, b) => a.sequence - b.sequence);

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Load-Level Documents
        </h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <Select
            label="Document Type"
            options={[
              { value: '', label: 'Select type…' },
              ...uploadableTypes.map((t) => ({ value: t.id, label: t.label })),
            ]}
            value={uploadTypeId}
            onChange={(e) => setUploadTypeId(e.target.value)}
          />
          <FileUploadField
            label="Upload"
            disabled={!uploadTypeId}
            onUpload={(file) =>
              documentsApi.uploadLoadDocumentAndConfirm(
                { entityType: 'LOAD', entityId: load.id, documentTypeId: uploadTypeId },
                file,
              )
            }
            onCheckScanStatus={(documentId) =>
              documentsApi.checkScanStatus('LOAD', load.id, documentId)
            }
            onComplete={() => refetchLoadDocs()}
          />
        </div>
      </div>
      <DataTable
        rows={currentDocs}
        rowKey={(d) => d.id}
        emptyMessage="No documents uploaded yet."
        columns={[
          {
            key: 'type',
            header: 'Type',
            render: (d) => loadDocTypes.find((t) => t.id === d.documentTypeId)?.label ?? '—',
          },
          { key: 'file', header: 'File', render: (d) => d.fileName },
          { key: 'version', header: 'Version', render: (d) => `v${d.versionNumber}` },
          {
            key: 'uploaded',
            header: 'Uploaded By/At',
            render: (d) => formatDateShort(d.uploadedAt),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (d) => (
              <LoadDocumentActionsCell
                doc={d}
                load={load}
                toast={toast}
                onChanged={() => refetchLoadDocs()}
                onDeleteRequested={setDeleting}
              />
            ),
          },
        ]}
      />

      <h2 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
        Proof of Pickup / Delivery by Stop
      </h2>
      {podPopStops.length === 0 ? (
        <span className="detail-field-value">No pickup or delivery stops on this load.</span>
      ) : (
        podPopStops.map((stop) => (
          <StopDocumentRow key={stop.id} loadId={load.id} stop={stop} toast={toast} />
        ))
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete document?"
        message={`This will permanently delete "${deleting?.fileName ?? ''}" and all of its versions. This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        loading={isDeleting}
        onCancel={() => setDeleting(null)}
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}

/**
 * One row per pickup or delivery Stop — which document type applies, its
 * label, and which upload API to call are all derived from `stop.stopType`
 * alone (never sequence/index/first/last), so this single component
 * correctly handles any number of pickups/deliveries in any order without
 * a second, duplicated row implementation.
 */
function StopDocumentRow({
  loadId,
  stop,
  toast,
}: {
  loadId: string;
  stop: Load['stops'][number];
  toast: ReturnType<typeof useToast>;
}) {
  const isPickup = stop.stopType === 'PICKUP';
  const code = isPickup ? 'POP' : 'POD';
  const docLabel = isPickup ? 'Proof of Pickup' : 'Proof of Delivery';
  const upload = isPickup
    ? documentsApi.uploadPopDocumentAndConfirm
    : documentsApi.uploadPodDocumentAndConfirm;

  const { data: docs = [], refetch } = useQuery({
    queryKey: ['documents', 'STOP', stop.id],
    queryFn: () => documentsApi.list('STOP', stop.id),
  });
  const current = docs.find((d) => d.isCurrentVersion);

  return (
    <div className="detail-card">
      <div className="detail-section-header">
        <div>
          <div className="detail-field-label">
            Stop {stop.sequence} — {stop.city}, {stop.state}
            {' — '}
            {docLabel}
            {stop.stopPurpose === 'RETURN' ? ' (Return)' : ''}
          </div>
          <div className="detail-field-value">
            {current ? `${current.fileName} (v${current.versionNumber})` : 'Not received.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          {current ? <ScanStatusCell doc={current} toast={toast} /> : null}
          <FileUploadField
            label={current ? `Replace ${code}` : `Upload ${code}`}
            onUpload={(file) =>
              upload(loadId, stop.sequence, { existingDocumentFamilyId: current?.id }, file)
            }
            onCheckScanStatus={(documentId) =>
              documentsApi.checkScanStatus('STOP', stop.id, documentId)
            }
            onComplete={() => refetch()}
          />
        </div>
      </div>
    </div>
  );
}
