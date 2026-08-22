import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { EQUIPMENT_TYPES } from '@tms/shared-constants';
import type { AddCustomerRateAgreementRequest, Customer } from '../../../api';
import { customersApi } from '../../../api';
import {
  Badge,
  Button,
  CurrencyInput,
  DataTable,
  DatePicker,
  Modal,
  ModalFooter,
  Select,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

const EQUIPMENT_OPTIONS = EQUIPMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));

function isExpired(expirationDate?: string): boolean {
  return Boolean(expirationDate && new Date(expirationDate) < new Date());
}

export function RateAgreementsTab({ customer }: { customer: Customer }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<AddCustomerRateAgreementRequest>();

  async function onSubmit(values: AddCustomerRateAgreementRequest) {
    await customersApi.addRateAgreement(customer.id, values);
    await queryClient.invalidateQueries({ queryKey: ['customers', customer.id] });
    toast.success('Rate agreement added.');
    reset();
    setAdding(false);
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Rate Agreements
        </h2>
        {can('manageCustomers') ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + Add Rate Agreement
          </Button>
        ) : null}
      </div>

      <DataTable
        rows={customer.rateAgreements ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No rate agreements yet."
        columns={[
          { key: 'origin', header: 'Origin', render: (r) => `${r.originCity}, ${r.originState}` },
          {
            key: 'dest',
            header: 'Destination',
            render: (r) => `${r.destinationCity}, ${r.destinationState}`,
          },
          {
            key: 'equipment',
            header: 'Equipment',
            render: (r) => r.equipmentType.replace('_', ' '),
          },
          { key: 'rate', header: 'Rate', numeric: true, render: (r) => `$${r.rate}` },
          { key: 'rateType', header: 'Rate Type', render: (r) => r.rateType },
          {
            key: 'status',
            header: 'Status',
            render: (r) =>
              isExpired(r.expirationDate) ? (
                <Badge label="Expired" color="neutral" />
              ) : (
                <Badge label="Active" color="success" />
              ),
          },
        ]}
      />

      <Modal
        open={adding}
        title="Add Rate Agreement"
        onClose={() => setAdding(false)}
        size="form"
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Add Rate Agreement"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="detail-card-grid">
            <TextField
              label="Origin City"
              required
              {...register('originCity', { required: true })}
            />
            <TextField
              label="Origin State"
              required
              {...register('originState', { required: true })}
            />
            <TextField
              label="Destination City"
              required
              {...register('destinationCity', { required: true })}
            />
            <TextField
              label="Destination State"
              required
              {...register('destinationState', { required: true })}
            />
          </div>
          <Select
            label="Equipment Type"
            required
            options={EQUIPMENT_OPTIONS}
            {...register('equipmentType', { required: true })}
          />
          <CurrencyInput label="Rate" required {...register('rate', { required: true })} />
          <TextField label="Rate Type" required {...register('rateType', { required: true })} />
          <div className="detail-card-grid">
            <DatePicker
              label="Effective Date"
              required
              {...register('effectiveDate', { required: true })}
            />
            <DatePicker label="Expiration Date" {...register('expirationDate')} />
          </div>
          <TextField label="Fuel Surcharge Rules" {...register('fuelSurchargeRules')} />
        </form>
      </Modal>
    </div>
  );
}
