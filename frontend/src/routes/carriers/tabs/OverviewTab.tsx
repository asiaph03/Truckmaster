import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { CARRIER_SERVICE_AREA_TYPES } from '@tms/shared-constants';
import type { AddServiceAreaRequest, Carrier } from '../../../api';
import { carriersApi } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Badge, Button, Modal, ModalFooter, Select, TextField } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';
import '../../shared/DetailPage.css';

/**
 * Workflow 3 §3.8's 7 eligibility conditions, checked against the
 * backend's own `ineligibilityReasons` strings (verbatim substring
 * match) rather than re-implementing the eligibility computation.
 */
const ELIGIBILITY_CHECKLIST: { label: string; reasonMatch: string }[] = [
  { label: 'Carrier status is Active', reasonMatch: 'Carrier status is not Active' },
  { label: 'Notice of Assignment approved', reasonMatch: 'Notice of Assignment is not approved' },
  { label: 'W9 approved', reasonMatch: 'W9 is not approved' },
  {
    label: 'Auto Liability insurance approved, not expired',
    reasonMatch: 'Auto Liability insurance',
  },
  { label: 'Cargo insurance approved, not expired', reasonMatch: 'Cargo insurance' },
  { label: 'MC Authority approved', reasonMatch: 'MC Authority is not approved' },
  { label: 'FMCSA/SAFER verification acceptable', reasonMatch: 'FMCSA/SAFER verification' },
];

const AREA_TYPE_OPTIONS = CARRIER_SERVICE_AREA_TYPES.map((t) => ({ value: t, label: t }));

export function OverviewTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [addingArea, setAddingArea] = useState(false);
  const { register, handleSubmit, watch, reset, formState } = useForm<AddServiceAreaRequest>({
    defaultValues: { type: 'LANE' },
  });
  const areaType = watch('type');

  async function onAddArea(values: AddServiceAreaRequest) {
    try {
      await carriersApi.addServiceArea(carrier.id, values);
      await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
      toast.success('Service area added.');
      reset({ type: 'LANE' });
      setAddingArea(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  const equipmentTypes = Array.from(
    new Set([
      ...(carrier.trucks ?? []).filter((t) => t.active).map((t) => t.truckType),
      ...(carrier.trailers ?? []).filter((t) => t.active).map((t) => t.trailerType),
    ]),
  );

  return (
    <div>
      <div className="detail-card">
        <h2 className="detail-card-title">Carrier Info</h2>
        <div className="detail-card-grid">
          <Field label="Legal Name" value={carrier.legalName} />
          <Field label="DBA" value={carrier.dba || '—'} />
          <Field label="MC Number" value={carrier.mcNumber} />
          <Field label="DOT Number" value={carrier.dotNumber} />
          <Field
            label="Address"
            value={`${carrier.addressLine1}, ${carrier.city}, ${carrier.state} ${carrier.zip}`}
          />
          <Field
            label="Primary Contact"
            value={`${carrier.primaryContactName} — ${carrier.primaryContactPhone}`}
          />
        </div>
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Eligibility Checklist</h2>
        {carrier.ineligibilityReasons === null ? (
          <p style={{ color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
            Not yet evaluated — eligibility is computed once an insurance record, FMCSA
            verification, or compliance document review occurs.
          </p>
        ) : (
          ELIGIBILITY_CHECKLIST.map((item) => {
            const failing = carrier.ineligibilityReasons!.some((r) => r.includes(item.reasonMatch));
            return (
              <div
                key={item.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: '4px 0',
                }}
              >
                {failing ? (
                  <X size={16} color="var(--danger-600)" />
                ) : (
                  <Check size={16} color="var(--success-600)" />
                )}
                <span>{item.label}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Equipment Types</h2>
        {equipmentTypes.length === 0 ? (
          <span className="detail-field-value">No active trucks/trailers yet.</span>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {equipmentTypes.map((t) => (
              <Badge key={t} label={t.replace('_', ' ')} color="neutral" />
            ))}
          </div>
        )}
      </div>

      <div className="detail-card">
        <div className="detail-section-header">
          <h2 className="detail-card-title" style={{ margin: 0 }}>
            Lane / Region Preferences
          </h2>
          {can('manageCarriers') ? (
            <Button variant="tertiary" size="sm" onClick={() => setAddingArea(true)}>
              + Add
            </Button>
          ) : null}
        </div>
        {(carrier.serviceAreas ?? []).length === 0 ? (
          <span className="detail-field-value">No lane/region preferences yet.</span>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {carrier.serviceAreas?.map((area) => (
              <Badge
                key={area.id}
                label={
                  area.type === 'LANE'
                    ? `${area.originCity}, ${area.originState} → ${area.destinationCity}, ${area.destinationState}`
                    : (area.regionLabel ?? '')
                }
                color="brand"
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={addingArea}
        title="Add Lane / Region"
        onClose={() => setAddingArea(false)}
        footer={
          <ModalFooter
            onCancel={() => setAddingArea(false)}
            onConfirm={handleSubmit(onAddArea)}
            confirmLabel="Add"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onAddArea)}>
          <Select label="Type" options={AREA_TYPE_OPTIONS} {...register('type')} />
          {areaType === 'LANE' ? (
            <div className="detail-card-grid">
              <TextField label="Origin City" {...register('originCity', { required: true })} />
              <TextField label="Origin State" {...register('originState', { required: true })} />
              <TextField
                label="Destination City"
                {...register('destinationCity', { required: true })}
              />
              <TextField
                label="Destination State"
                {...register('destinationState', { required: true })}
              />
            </div>
          ) : (
            <TextField label="Region Label" {...register('regionLabel', { required: true })} />
          )}
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
