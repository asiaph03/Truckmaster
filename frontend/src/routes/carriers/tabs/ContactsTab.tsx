import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { CARRIER_CONTACT_ROLES } from '@tms/shared-constants';
import type { AddCarrierContactRequest, Carrier } from '../../../api';
import { carriersApi } from '../../../api';
import {
  Badge,
  Button,
  DataTable,
  Modal,
  ModalFooter,
  Select,
  TextField,
  Toggle,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

const ROLE_OPTIONS = CARRIER_CONTACT_ROLES.map((r) => ({ value: r, label: r.replace('_', ' ') }));

export function ContactsTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<AddCarrierContactRequest>();

  async function onSubmit(values: AddCarrierContactRequest) {
    await carriersApi.addContact(carrier.id, values);
    await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
    toast.success('Contact added.');
    reset();
    setAdding(false);
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Contacts
        </h2>
        {can('manageCarriers') ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + Add Contact
          </Button>
        ) : null}
      </div>

      <DataTable
        rows={carrier.contacts ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No contacts yet."
        columns={[
          { key: 'name', header: 'Name', render: (r) => r.name },
          { key: 'email', header: 'Email', render: (r) => r.email ?? '—' },
          { key: 'phone', header: 'Phone', render: (r) => r.phone ?? '—' },
          {
            key: 'role',
            header: 'Role',
            render: (r) => <Badge label={r.role.replace('_', ' ')} color="neutral" />,
          },
          { key: 'primary', header: 'Primary', render: (r) => (r.isPrimary ? 'Yes' : '') },
        ]}
      />

      <Modal
        open={adding}
        title="Add Contact"
        onClose={() => setAdding(false)}
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Add Contact"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <TextField label="Name" required {...register('name', { required: true })} />
          <TextField label="Email" type="email" {...register('email')} />
          <TextField label="Phone" {...register('phone')} />
          <Select
            label="Role"
            required
            options={ROLE_OPTIONS}
            {...register('role', { required: true })}
          />
          <Toggle label="Primary contact" {...register('isPrimary')} />
        </form>
      </Modal>
    </div>
  );
}
