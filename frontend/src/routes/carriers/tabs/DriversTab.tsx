import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import type { AddDriverRequest, Carrier } from '../../../api';
import { carriersApi } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Badge, Button, DataTable, Modal, ModalFooter, TextField } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

export function DriversTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<AddDriverRequest>();

  async function onSubmit(values: AddDriverRequest) {
    try {
      await carriersApi.addDriver(carrier.id, values);
      await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
      toast.success('Driver added.');
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
          Drivers
        </h2>
        {can('manageCarriers') ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + Add Driver
          </Button>
        ) : null}
      </div>

      <DataTable
        rows={carrier.drivers ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No drivers yet."
        columns={[
          { key: 'name', header: 'Name', render: (r) => `${r.firstName} ${r.lastName}` },
          { key: 'phone', header: 'Phone', render: (r) => r.phone },
          { key: 'email', header: 'Email', render: (r) => r.email ?? '—' },
          { key: 'license', header: 'License #', render: (r) => r.licenseNumber ?? '—' },
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
        title="Add Driver"
        onClose={() => setAdding(false)}
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Add Driver"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="detail-card-grid">
            <TextField label="First Name" required {...register('firstName', { required: true })} />
            <TextField label="Last Name" required {...register('lastName', { required: true })} />
          </div>
          <TextField label="Phone" required {...register('phone', { required: true })} />
          <TextField label="Email" type="email" {...register('email')} />
          <TextField label="License Number" {...register('licenseNumber')} />
        </form>
      </Modal>
    </div>
  );
}
