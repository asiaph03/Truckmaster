import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import type { AddDriverRequest, Carrier, CarrierDriver, UpdateDriverRequest } from '../../../api';
import { carriersApi } from '../../../api';
import { ApiError } from '../../../api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Modal,
  ModalFooter,
  RowActionsMenu,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

/** Only the fields UpdateDriverDto declares — mirrors carrierToFormValue's own reasoning. */
function driverToFormValue(driver: CarrierDriver): UpdateDriverRequest {
  return {
    firstName: driver.firstName,
    lastName: driver.lastName,
    phone: driver.phone,
    email: driver.email,
    licenseNumber: driver.licenseNumber,
    notes: driver.notes,
  };
}

export function DriversTab({ carrier }: { carrier: Carrier }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editingDriver, setEditingDriver] = useState<CarrierDriver | null>(null);
  const [deactivatingDriver, setDeactivatingDriver] = useState<CarrierDriver | null>(null);
  const [reactivatingDriver, setReactivatingDriver] = useState<CarrierDriver | null>(null);

  const addForm = useForm<AddDriverRequest>();
  const editForm = useForm<UpdateDriverRequest>();

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ['carriers', carrier.id] });
  }

  async function onAddSubmit(values: AddDriverRequest) {
    try {
      await carriersApi.addDriver(carrier.id, values);
      await invalidate();
      toast.success('Driver added.');
      addForm.reset();
      setAdding(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onEditSubmit(values: UpdateDriverRequest) {
    if (!editingDriver) return;
    try {
      await carriersApi.updateDriver(carrier.id, editingDriver.id, values);
      await invalidate();
      toast.success('Driver updated.');
      setEditingDriver(null);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onDeactivate(reason?: string) {
    if (!deactivatingDriver) return;
    try {
      await carriersApi.deactivateDriver(carrier.id, deactivatingDriver.id, {
        reason: reason ?? '',
      });
      await invalidate();
      toast.success('Driver deactivated.');
      setDeactivatingDriver(null);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onReactivate(reason?: string) {
    if (!reactivatingDriver) return;
    try {
      await carriersApi.reactivateDriver(carrier.id, reactivatingDriver.id, {
        reason: reason ?? '',
      });
      await invalidate();
      toast.success('Driver reactivated.');
      setReactivatingDriver(null);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  const canManage = can('manageCarriers');

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Drivers
        </h2>
        {canManage ? (
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
        rowActions={
          canManage
            ? (r) => (
                <RowActionsMenu>
                  <button
                    className="data-table-row-action"
                    onClick={() => {
                      editForm.reset(driverToFormValue(r));
                      setEditingDriver(r);
                    }}
                  >
                    Edit
                  </button>
                  {r.active ? (
                    <button
                      className="data-table-row-action"
                      onClick={() => setDeactivatingDriver(r)}
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      className="data-table-row-action"
                      onClick={() => setReactivatingDriver(r)}
                    >
                      Reactivate
                    </button>
                  )}
                </RowActionsMenu>
              )
            : undefined
        }
      />

      <Modal
        open={adding}
        title="Add Driver"
        onClose={() => setAdding(false)}
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={addForm.handleSubmit(onAddSubmit)}
            confirmLabel="Add Driver"
            loading={addForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={addForm.handleSubmit(onAddSubmit)}>
          <div className="detail-card-grid">
            <TextField
              label="First Name"
              required
              {...addForm.register('firstName', { required: true })}
            />
            <TextField
              label="Last Name"
              required
              {...addForm.register('lastName', { required: true })}
            />
          </div>
          <TextField label="Phone" required {...addForm.register('phone', { required: true })} />
          <TextField label="Email" type="email" {...addForm.register('email')} />
          <TextField label="License Number" {...addForm.register('licenseNumber')} />
        </form>
      </Modal>

      <Modal
        open={Boolean(editingDriver)}
        title="Edit Driver"
        onClose={() => setEditingDriver(null)}
        footer={
          <ModalFooter
            onCancel={() => setEditingDriver(null)}
            onConfirm={editForm.handleSubmit(onEditSubmit)}
            confirmLabel="Save"
            loading={editForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={editForm.handleSubmit(onEditSubmit)}>
          <div className="detail-card-grid">
            <TextField
              label="First Name"
              required
              {...editForm.register('firstName', { required: true })}
            />
            <TextField
              label="Last Name"
              required
              {...editForm.register('lastName', { required: true })}
            />
          </div>
          <TextField label="Phone" required {...editForm.register('phone', { required: true })} />
          <TextField label="Email" type="email" {...editForm.register('email')} />
          <TextField label="License Number" {...editForm.register('licenseNumber')} />
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(deactivatingDriver)}
        title="Deactivate Driver"
        message="This driver will no longer be available for new dispatch assignment until reactivated. Existing assigned loads are not affected."
        confirmLabel="Deactivate Driver"
        confirmVariant="destructive"
        requireReason
        onCancel={() => setDeactivatingDriver(null)}
        onConfirm={onDeactivate}
      />

      <ConfirmDialog
        open={Boolean(reactivatingDriver)}
        title="Reactivate Driver"
        message="This driver will become available for new dispatch assignment again."
        confirmLabel="Reactivate Driver"
        requireReason
        onCancel={() => setReactivatingDriver(null)}
        onConfirm={onReactivate}
      />
    </div>
  );
}
