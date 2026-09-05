import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import type { Carrier, UpdateFactoringInfoRequest } from '../../../api';
import { carriersApi } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Button, Modal, ModalFooter, TextField, Toggle } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

/** UI_UX_DESIGN.md §5.4.6 — informational only in V1, no eligibility effect. */
export function FactoringTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const { register, handleSubmit, formState, reset } = useForm<UpdateFactoringInfoRequest>();

  async function onSubmit(values: UpdateFactoringInfoRequest) {
    try {
      await carriersApi.upsertFactoring(carrier.id, values);
      await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
      toast.success('Factoring info saved.');
      setEditing(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  const info = carrier.factoringInfo;

  return (
    <div>
      <div className="detail-card">
        <div className="detail-section-header">
          <h2 className="detail-card-title" style={{ margin: 0 }}>
            Factoring
          </h2>
          {can('manageCarriers') ? (
            <Button
              variant="tertiary"
              size="sm"
              onClick={() => {
                reset(info ?? { usesFactoring: false });
                setEditing(true);
              }}
            >
              Edit
            </Button>
          ) : null}
        </div>

        <p style={{ color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
          Factoring information is informational only in V1 and does not affect assignment
          eligibility.
        </p>

        {info?.usesFactoring ? (
          <div className="detail-card-grid">
            <Field label="Factoring Company" value={info.factoringCompany || '—'} />
            <Field label="Remit-To Address" value={info.remitToAddress || '—'} />
            <Field label="Factoring Contact" value={info.factoringContact || '—'} />
            <Field label="Payment Instructions" value={info.paymentInstructions || '—'} />
            <Field label="NOA Status" value={info.noaStatus || '—'} />
          </div>
        ) : (
          <span className="detail-field-value">Not using factoring.</span>
        )}
      </div>

      <Modal
        open={editing}
        title="Edit Factoring Info"
        onClose={() => setEditing(false)}
        size="form"
        footer={
          <ModalFooter
            onCancel={() => setEditing(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Save"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <Toggle label="Uses Factoring" {...register('usesFactoring')} />
          <TextField label="Factoring Company" {...register('factoringCompany')} />
          <TextField label="Remit-To Address" {...register('remitToAddress')} />
          <TextField label="Factoring Contact" {...register('factoringContact')} />
          <TextField label="Payment Instructions" {...register('paymentInstructions')} />
          <TextField label="NOA Status" {...register('noaStatus')} />
        </form>
      </Modal>
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
