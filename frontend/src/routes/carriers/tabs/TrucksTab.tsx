import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { EQUIPMENT_TYPES } from '@tms/shared-constants';
import type { AddTruckRequest, Carrier } from '../../../api';
import { carriersApi } from '../../../api';
import { ApiError } from '../../../api/errors';
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

export function TrucksTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<AddTruckRequest>();

  async function onSubmit(values: AddTruckRequest) {
    try {
      await carriersApi.addTruck(carrier.id, {
        ...values,
        year: values.year ? Number(values.year) : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
      toast.success('Truck added.');
      reset();
      setAdding(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Trucks
        </h2>
        {can('manageCarriers') ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + Add Truck
          </Button>
        ) : null}
      </div>

      <DataTable
        rows={carrier.trucks ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No trucks yet."
        columns={[
          { key: 'unit', header: 'Unit #', render: (r) => r.unitNumber },
          { key: 'type', header: 'Type', render: (r) => r.truckType.replace('_', ' ') },
          {
            key: 'makeModel',
            header: 'Make/Model/Year',
            render: (r) => [r.make, r.model, r.year].filter(Boolean).join(' ') || '—',
          },
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
        title="Add Truck"
        onClose={() => setAdding(false)}
        size="form"
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Add Truck"
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
            {...register('truckType', { required: true })}
          />
          <div className="detail-card-grid">
            <TextField label="Make" {...register('make')} />
            <TextField label="Model" {...register('model')} />
            <TextField label="Year" type="number" {...register('year')} />
            <TextField label="VIN" {...register('vin')} />
            <TextField label="Plate" {...register('plate')} />
          </div>
        </form>
      </Modal>
    </div>
  );
}
