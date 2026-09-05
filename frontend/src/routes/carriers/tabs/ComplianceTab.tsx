import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FMCSA_RESULT_STATUS_OPTIONS } from '@tms/shared-constants';
import type { AddFmcsaVerificationRequest, Carrier } from '../../../api';
import { carriersApi, documentsApi, documentTypesApi } from '../../../api';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  FileUploadField,
  Modal,
  ModalFooter,
  Select,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';
import { useSessionStore } from '../../../auth/session-store';

const RESULT_STATUS_OPTIONS = FMCSA_RESULT_STATUS_OPTIONS.map((s) => ({ value: s, label: s }));

const COMPLIANCE_TYPE_CODES = ['W9', 'CARRIER_AGREEMENT', 'MC_AUTHORITY'];

export function ComplianceTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const userId = useSessionStore((s) => s.userId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [addingVerification, setAddingVerification] = useState(false);

  const { data: docTypes = [] } = useQuery({
    queryKey: ['document-types', 'CARRIER_COMPLIANCE'],
    queryFn: () => documentTypesApi.list('CARRIER_COMPLIANCE'),
  });

  const { data: documents = [], refetch: refetchDocuments } = useQuery({
    queryKey: ['documents', 'CARRIER', carrier.id],
    queryFn: () => documentsApi.list('CARRIER', carrier.id),
  });

  // Dedupe by code — defensive only. `DocumentTypeDefinition` rows are
  // meant to be one-per-code (system defaults, seeded once), but this
  // guards the row-per-required-type checklist against duplicate rows
  // from any source rather than rendering the same document type twice.
  const requiredTypes = Array.from(
    new Map(
      docTypes.filter((t) => COMPLIANCE_TYPE_CODES.includes(t.code)).map((t) => [t.code, t]),
    ).values(),
  );

  const verificationForm = useForm<AddFmcsaVerificationRequest & { resultStatusOther?: string }>();
  const selectedResultStatus = verificationForm.watch('resultStatus');

  async function onAddVerification(
    values: AddFmcsaVerificationRequest & { resultStatusOther?: string },
  ) {
    const resultStatus =
      values.resultStatus === 'OTHER' ? (values.resultStatusOther ?? '') : values.resultStatus;
    await carriersApi.recordFmcsaVerification(carrier.id, { ...values, resultStatus });
    await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
    toast.success('FMCSA verification recorded.');
    verificationForm.reset();
    setAddingVerification(false);
  }

  async function handleApprove(documentId: string) {
    await documentsApi.review(documentId, { decision: 'APPROVED' });
    await refetchDocuments();
    await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
    toast.success('Document approved.');
  }

  async function handleReject(documentId: string, reason?: string) {
    await documentsApi.review(documentId, { decision: 'REJECTED', rejectionReason: reason });
    await refetchDocuments();
    await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
    toast.success('Document rejected.');
    setRejecting(null);
  }

  const rows = requiredTypes.map((type) => {
    const doc = documents.find((d) => d.documentTypeId === type.id && d.isCurrentVersion);
    return { type, doc };
  });

  return (
    <div>
      <DataTable
        rows={rows}
        rowKey={(r) => r.type.id}
        emptyMessage="No compliance document types configured."
        columns={[
          { key: 'label', header: 'Document', render: (r) => r.type.label },
          {
            key: 'status',
            header: 'Review Status',
            render: (r) =>
              r.doc ? (
                <Badge
                  label={r.doc.reviewStatus.replace('_', ' ')}
                  color={
                    getStatusBadgeColor('Document.reviewStatus', r.doc.reviewStatus) ?? 'neutral'
                  }
                />
              ) : (
                <Badge label="Not Uploaded" color="neutral" />
              ),
          },
          {
            key: 'uploaded',
            header: 'Uploaded',
            render: (r) => (r.doc ? new Date(r.doc.uploadedAt).toLocaleDateString() : '—'),
          },
          {
            key: 'expiration',
            header: 'Expiration',
            render: (r) =>
              r.doc?.expirationDate ? new Date(r.doc.expirationDate).toLocaleDateString() : '—',
          },
          {
            key: 'actions',
            header: '',
            render: (r) => {
              const isOwnUpload = r.doc?.uploadedByUserId === userId;
              return (
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                  {can('manageCarriers') ? (
                    <FileUploadField
                      label={r.doc ? 'Replace' : 'Upload'}
                      onUpload={(file) =>
                        documentsApi.uploadCarrierDocumentAndConfirm(
                          carrier.id,
                          {
                            documentTypeId: r.type.id,
                            existingDocumentFamilyId: r.doc?.documentFamilyId,
                          },
                          file,
                        )
                      }
                      onCheckScanStatus={(documentId) =>
                        documentsApi.checkScanStatus('CARRIER', carrier.id, documentId)
                      }
                      onComplete={() => refetchDocuments()}
                    />
                  ) : null}
                  {r.doc?.reviewStatus === 'PENDING_REVIEW' && can('reviewComplianceDocuments') ? (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isOwnUpload}
                        title={
                          isOwnUpload ? 'You cannot review a document you uploaded' : undefined
                        }
                        onClick={() => r.doc && handleApprove(r.doc.id)}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={isOwnUpload}
                        title={
                          isOwnUpload ? 'You cannot review a document you uploaded' : undefined
                        }
                        onClick={() => r.doc && setRejecting(r.doc.id)}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}
                </div>
              );
            },
          },
        ]}
      />

      <div className="detail-card" style={{ marginTop: 'var(--space-4)' }}>
        <div className="detail-section-header">
          <h2 className="detail-card-title" style={{ margin: 0 }}>
            FMCSA / SAFER Verification
          </h2>
          {can('recordFmcsaVerification') ? (
            <Button variant="tertiary" size="sm" onClick={() => setAddingVerification(true)}>
              Record Verification
            </Button>
          ) : null}
        </div>
        {(carrier.fmcsaVerifications?.length ?? 0) === 0 ? (
          <span className="detail-field-value">No verification recorded yet.</span>
        ) : (
          <div className="detail-card-grid">
            <Field
              label="Date"
              value={new Date(carrier.fmcsaVerifications![0].verificationDate).toLocaleDateString()}
            />
            <Field label="Result" value={carrier.fmcsaVerifications![0].resultStatus} />
            <Field
              label="Authority Info"
              value={carrier.fmcsaVerifications![0].authorityInfo || '—'}
            />
            <Field label="Notes" value={carrier.fmcsaVerifications![0].notes || '—'} />
          </div>
        )}
      </div>

      <Modal
        open={addingVerification}
        title="Record FMCSA Verification"
        onClose={() => setAddingVerification(false)}
        footer={
          <ModalFooter
            onCancel={() => setAddingVerification(false)}
            onConfirm={verificationForm.handleSubmit(onAddVerification)}
            confirmLabel="Record"
            loading={verificationForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={verificationForm.handleSubmit(onAddVerification)}>
          <TextField
            label="Verification Date"
            type="date"
            required
            {...verificationForm.register('verificationDate', { required: true })}
          />
          <Select
            label="Result"
            required
            options={RESULT_STATUS_OPTIONS}
            {...verificationForm.register('resultStatus', { required: true })}
          />
          {selectedResultStatus === 'OTHER' ? (
            <TextField
              label="Other Result (free text)"
              required
              {...verificationForm.register('resultStatusOther', { required: true })}
            />
          ) : null}
          <TextField label="Authority Info" {...verificationForm.register('authorityInfo')} />
          <TextField label="Notes" {...verificationForm.register('notes')} />
        </form>
      </Modal>

      <ConfirmDialog
        open={rejecting !== null}
        title="Reject Document"
        message="This will mark the document as rejected."
        confirmLabel="Reject Document"
        confirmVariant="destructive"
        requireReason
        onCancel={() => setRejecting(null)}
        onConfirm={(reason) => rejecting && handleReject(rejecting, reason)}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="detail-field-label">{label}</div>
      <div className="detail-field-value">{value}</div>
    </div>
  );
}
