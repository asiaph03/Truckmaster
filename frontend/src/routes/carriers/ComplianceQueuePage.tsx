import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { documentsApi, type PendingReviewDocument } from '../../api';
import { ApiError } from '../../api/errors';
import { Badge, Button, ConfirmDialog, DataTable } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { useSessionStore } from '../../auth/session-store';
import '../shared/ListPage.css';

/**
 * UI_UX_DESIGN.md §5.4.6 line 1128 — `/carriers/compliance-queue`, named
 * in the sitemap but explicitly "not in this pass's critical-screen set"
 * (no locked layout). Built against the list-page convention, reusing
 * the exact Approve/Reject/self-review-block rules already live on
 * CarrierDetailPage's ComplianceTab (documentsApi.review, the same
 * `SelfReviewForbiddenError` the backend enforces regardless of what
 * this UI shows/hides) rather than a second implementation of the same
 * business rule. Entire screen is Compliance-Reviewer-only, matching the
 * backend's `GET /documents/pending-review` role restriction exactly —
 * no Admin override, since the backend has none.
 */
export function ComplianceQueuePage() {
  const userId = useSessionStore((s) => s.userId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState<PendingReviewDocument | null>(null);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['documents', 'pending-review'],
    queryFn: () => documentsApi.listPendingReview(),
  });

  function afterMutation() {
    queryClient.invalidateQueries({ queryKey: ['documents', 'pending-review'] });
  }

  async function handleApprove(doc: PendingReviewDocument) {
    try {
      await documentsApi.review(doc.id, { decision: 'APPROVED' });
      toast.success(`${doc.documentType.label} approved.`);
      afterMutation();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function handleReject(reason?: string) {
    if (!rejecting) return;
    try {
      await documentsApi.review(rejecting.id, { decision: 'REJECTED', rejectionReason: reason });
      toast.success(`${rejecting.documentType.label} rejected.`);
      setRejecting(null);
      afterMutation();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <div className="list-page-header">
        <div>
          <h1 className="list-page-title">Compliance Review Queue</h1>
          <p style={{ margin: 0, color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
            Every Carrier compliance document currently Pending Review, across all carriers.
          </p>
        </div>
      </div>

      <DataTable
        loading={isLoading}
        rows={documents}
        rowKey={(d) => d.id}
        emptyMessage="Nothing is pending review."
        columns={[
          {
            key: 'carrier',
            header: 'Carrier',
            render: (d) => (
              <Link to={`/carriers/${d.entityId}`}>{d.carrierLegalName ?? d.entityId}</Link>
            ),
          },
          { key: 'type', header: 'Document', render: (d) => d.documentType.label },
          { key: 'file', header: 'File', render: (d) => d.fileName },
          {
            key: 'uploaded',
            header: 'Uploaded',
            render: (d) => new Date(d.uploadedAt).toLocaleString(),
          },
          {
            key: 'scan',
            header: 'Scan',
            render: (d) => (
              <Badge
                label={d.scanStatus}
                color={
                  d.scanStatus === 'CLEAN'
                    ? 'success'
                    : d.scanStatus === 'PENDING'
                      ? 'neutral'
                      : 'danger'
                }
              />
            ),
          },
          {
            key: 'actions',
            header: '',
            render: (d) => {
              const isOwnUpload = d.uploadedByUserId === userId;
              return (
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isOwnUpload}
                    title={isOwnUpload ? 'You cannot review a document you uploaded' : undefined}
                    onClick={() => handleApprove(d)}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isOwnUpload}
                    title={isOwnUpload ? 'You cannot review a document you uploaded' : undefined}
                    onClick={() => setRejecting(d)}
                  >
                    Reject
                  </Button>
                </div>
              );
            },
          },
        ]}
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
