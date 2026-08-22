import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddCarrierInsuranceRequest, Carrier, CarrierInsuranceRecord } from '../../../api';
import { carriersApi, documentsApi, documentTypesApi } from '../../../api';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import {
  Badge,
  Button,
  CurrencyInput,
  DatePicker,
  FileUploadField,
  Modal,
  ModalFooter,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

function expirationColor(expirationDate: string): 'danger' | 'warning' | 'success' {
  const days = (new Date(expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days <= 7) return 'danger';
  if (days <= 30) return 'warning';
  return 'success';
}

function CoverageCard({
  title,
  coverageType,
  record,
  carrierId,
  documents,
}: {
  title: string;
  coverageType: 'AUTO_LIABILITY' | 'CARGO';
  record?: CarrierInsuranceRecord;
  carrierId: string;
  documents: ReturnType<typeof useQuery<Awaited<ReturnType<typeof documentsApi.list>>>>['data'];
}) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [coiDocumentId, setCoiDocumentId] = useState<string | null>(record?.coiDocumentId ?? null);

  const { data: coiTypes = [] } = useQuery({
    queryKey: ['document-types', 'CARRIER_COMPLIANCE'],
    queryFn: () => documentTypesApi.list('CARRIER_COMPLIANCE'),
  });
  const coiTypeId = coiTypes.find((t) => t.code === 'COI')?.id;
  const coiDoc = documents?.find((d) => d.id === (coiDocumentId ?? record?.coiDocumentId));

  const { register, handleSubmit, formState, reset } = useForm<AddCarrierInsuranceRequest>();

  async function onSubmit(values: AddCarrierInsuranceRequest) {
    if (!coiDocumentId) return;
    await carriersApi.addInsurance(carrierId, { ...values, coverageType, coiDocumentId });
    await queryClient.invalidateQueries({ queryKey: ['carriers', carrierId] });
    toast.success(`${title} insurance saved.`);
    reset();
    setOpen(false);
  }

  return (
    <div className="detail-card">
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          {title}
        </h2>
        {can('addCarrierInsurance') ? (
          <Button variant="tertiary" size="sm" onClick={() => setOpen(true)}>
            {record ? 'Edit' : 'Add'}
          </Button>
        ) : null}
      </div>
      {record ? (
        <div className="detail-card-grid">
          <Field label="Coverage Amount" value={`$${record.coverageAmount}`} />
          <Field label="Insurance Company" value={record.insuranceCompany} />
          <Field label="Agent Contact" value={record.agentContact || '—'} />
          <Field
            label="Effective Date"
            value={new Date(record.effectiveDate).toLocaleDateString()}
          />
          <div>
            <div className="detail-field-label">Expiration Date</div>
            <Badge
              label={new Date(record.expirationDate).toLocaleDateString()}
              color={expirationColor(record.expirationDate)}
            />
          </div>
          <div>
            <div className="detail-field-label">COI Document</div>
            {coiDoc ? (
              <Badge
                label={coiDoc.reviewStatus.replace('_', ' ')}
                color={
                  getStatusBadgeColor('Document.reviewStatus', coiDoc.reviewStatus) ?? 'neutral'
                }
              />
            ) : (
              '—'
            )}
          </div>
        </div>
      ) : (
        <span className="detail-field-value">Not on file.</span>
      )}

      <Modal
        open={open}
        title={`${record ? 'Edit' : 'Add'} ${title} Insurance`}
        onClose={() => setOpen(false)}
        size="form"
        footer={
          <ModalFooter
            onCancel={() => setOpen(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Save"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="detail-field-label" style={{ marginBottom: 'var(--space-1)' }}>
            Certificate of Insurance
          </div>
          <FileUploadField
            label={coiDocumentId ? 'Replace COI' : 'Upload COI'}
            onUpload={(file) =>
              documentsApi.uploadCarrierDocumentAndConfirm(
                carrierId,
                { documentTypeId: coiTypeId ?? '' },
                file,
              )
            }
            onCheckScanStatus={(documentId) =>
              documentsApi.checkScanStatus('CARRIER', carrierId, documentId)
            }
            onComplete={(documentId) => setCoiDocumentId(documentId)}
          />
          {!coiTypeId ? (
            <p style={{ color: 'var(--danger-600)', fontSize: 'var(--text-small-size)' }}>
              COI document type not found — cannot upload.
            </p>
          ) : null}
          <CurrencyInput
            label="Coverage Amount"
            required
            {...register('coverageAmount', { required: true })}
          />
          <TextField
            label="Insurance Company"
            required
            {...register('insuranceCompany', { required: true })}
          />
          <TextField label="Agent Contact" {...register('agentContact')} />
          <div className="detail-card-grid">
            <DatePicker
              label="Effective Date"
              required
              {...register('effectiveDate', { required: true })}
            />
            <DatePicker
              label="Expiration Date"
              required
              {...register('expirationDate', { required: true })}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function InsuranceTab({ carrier }: { carrier: Carrier }) {
  const { data: documents } = useQuery({
    queryKey: ['documents', 'CARRIER', carrier.id],
    queryFn: () => documentsApi.list('CARRIER', carrier.id),
  });

  const auto = carrier.insuranceRecords?.find((r) => r.coverageType === 'AUTO_LIABILITY');
  const cargo = carrier.insuranceRecords?.find((r) => r.coverageType === 'CARGO');

  return (
    <div>
      <CoverageCard
        title="Auto Liability"
        coverageType="AUTO_LIABILITY"
        record={auto}
        carrierId={carrier.id}
        documents={documents}
      />
      <CoverageCard
        title="Cargo"
        coverageType="CARGO"
        record={cargo}
        carrierId={carrier.id}
        documents={documents}
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
