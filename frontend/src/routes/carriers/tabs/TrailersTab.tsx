import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { EQUIPMENT_TYPES } from '@tms/shared-constants';
import type { AddTrailerRequest, Carrier } from '../../../api';
import { carriersApi } from '../../../api';
import {
  Badge,
  Button,
  DataTable,
  Modal,
  ModalFooter,
  Select,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

const TYPE_OPTIONS = EQUIPMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));

export function TrailersTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<AddTrailerRequest>();

  async function onSubmit(values: AddTrailerRequest) {
    await carriersApi.addTrailer(carrier.id, values);
    await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
    toast.success('Trailer added.');
    reset();
    setAdding(false);
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Trailers
        </h2>
        {can('manageCarriers') ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + Add Trailer
          </Button>
        ) : null}
      </div>

      <DataTable
        rows={carrier.trailers ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No trailers yet."
        columns={[
          { key: 'unit', header: 'Unit #', render: (r) => r.unitNumber },
          { key: 'type', header: 'Type', render: (r) => r.trailerType.replace('_', ' ') },
          { key: 'vin', header: 'VIN', render: (r) => r.vin ?? '—' },
          { key: 'plate', header: 'Plate', render: (r) => r.plate ?? '—' },
          {
            key: 'active',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.active ? 'Active' : 'Inactive'}
                color={r.active ? 'success' : 'neutral'}
              />
            ),
          },
        ]}
      />

      <Modal
        open={adding}
        title="Add Trailer"
        onClose={() => setAdding(false)}
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Add Trailer"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <TextField label="Unit Number" required {...register('unitNumber', { required: true })} />
          <Select
            label="Type"
            required
            options={TYPE_OPTIONS}
            {...register('trailerType', { required: true })}
          />
          <TextField label="VIN" {...register('vin')} />
          <TextField label="Plate" {...register('plate')} />
        </form>
      </Modal>
    </div>
  );
}
