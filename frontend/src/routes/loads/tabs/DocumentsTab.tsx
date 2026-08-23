import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { documentTypesApi, documentsApi, type AppDocument, type Load } from '../../../api';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import { Badge, Button, DataTable, FileUploadField, Select } from '../../../components/ui';
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
  if (doc.scanStatus === 'CLEAN') {
    return (
      <Button variant="tertiary" size="sm" onClick={() => download(doc.id, toast)}>
        Download
      </Button>
    );
  }
  if (doc.scanStatus === 'PENDING') return <Badge label="Scanning…" color="neutral" />;
  return (
    <Badge
      label={doc.scanStatus === 'INFECTED' ? 'Blocked (Infected)' : 'Scan Failed'}
      color={getStatusBadgeColor('Document.scanStatus', doc.scanStatus) ?? 'danger'}
    />
  );
}

/**
 * UI_UX_DESIGN.md §5.4.4 Documents tab. Two grouped tables: Load-level
 * documents (generic, `entityType=LOAD`) and POD per delivery Stop
 * (`entityType=STOP`, Workflow 7 §7.1) — the two document families never
 * overlap since POD is only ever uploaded via the per-stop route,
 * excluded from the Load-level type picker below. No review-status UI
 * here (Load-level document types are `NOT_APPLICABLE` for review).
 */
export function DocumentsTab({ load }: { load: Load }) {
  const toast = useToast();
  const [uploadTypeId, setUploadTypeId] = useState('');

  const { data: loadDocTypes = [] } = useQuery({
    queryKey: ['document-types', 'LOAD'],
    queryFn: () => documentTypesApi.list('LOAD'),
  });
  const { data: loadDocuments = [], refetch: refetchLoadDocs } = useQuery({
    queryKey: ['documents', 'LOAD', load.id],
    queryFn: () => documentsApi.list('LOAD', load.id),
  });

  const uploadableTypes = loadDocTypes.filter((t) => t.code !== 'POD');
  const currentDocs = loadDocuments.filter((d) => d.isCurrentVersion);

  const deliveryStops = [...load.stops]
    .filter((s) => s.stopType === 'DELIVERY')
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
          { key: 'scan', header: '', render: (d) => <ScanStatusCell doc={d} toast={toast} /> },
        ]}
      />

      <h2 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
        POD by Delivery Stop
      </h2>
      {deliveryStops.length === 0 ? (
        <span className="detail-field-value">No delivery stops on this load.</span>
      ) : (
        deliveryStops.map((stop) => (
          <PodStopRow key={stop.id} loadId={load.id} stop={stop} toast={toast} />
        ))
      )}
    </div>
  );
}

function PodStopRow({
  loadId,
  stop,
  toast,
}: {
  loadId: string;
  stop: Load['stops'][number];
  toast: ReturnType<typeof useToast>;
}) {
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
          </div>
          <div className="detail-field-value">
            {current ? `${current.fileName} (v${current.versionNumber})` : 'Not received.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          {current ? <ScanStatusCell doc={current} toast={toast} /> : null}
          <FileUploadField
            label={current ? 'Replace' : 'Upload'}
            onUpload={(file) =>
              documentsApi.uploadPodDocumentAndConfirm(
                loadId,
                stop.sequence,
                { existingDocumentFamilyId: current?.id },
                file,
              )
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
