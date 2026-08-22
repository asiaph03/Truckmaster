import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Customer } from '../../../api';
import { customersApi, membershipsApi } from '../../../api';
import { Badge, Button, SearchableCombobox } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';
import '../../shared/DetailPage.css';

export function OverviewTab({ customer }: { customer: Customer }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [assigningOwner, setAssigningOwner] = useState(false);

  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
    enabled: assigningOwner,
  });

  const owner = memberships.find((m) => m.userId === customer.accountOwnerUserId);

  async function assignOwner(userId: string | null) {
    if (!userId) return;
    await customersApi.update(customer.id, { accountOwnerUserId: userId });
    await queryClient.invalidateQueries({ queryKey: ['customers', customer.id] });
    toast.success('Account owner assigned.');
    setAssigningOwner(false);
  }

  return (
    <div>
      <div className="detail-card">
        <h2 className="detail-card-title">Customer Info</h2>
        <div className="detail-card-grid">
          <Field label="Legal Name" value={customer.legalName} />
          <Field
            label="Billing Address"
            value={`${customer.billingAddressLine1}, ${customer.billingCity}, ${customer.billingState} ${customer.billingZip}`}
          />
          <Field label="Primary Contact" value={customer.primaryContactName} />
          <Field label="Email" value={customer.primaryContactEmail} />
          <Field label="Phone" value={customer.primaryContactPhone} />
        </div>
      </div>

      <div className="detail-card">
        <div className="detail-section-header">
          <h2 className="detail-card-title" style={{ margin: 0 }}>
            Account Owner
          </h2>
          {can('manageCustomers') && !assigningOwner ? (
            <Button variant="tertiary" size="sm" onClick={() => setAssigningOwner(true)}>
              {customer.accountOwnerUserId ? 'Change Owner' : 'Assign Owner'}
            </Button>
          ) : null}
        </div>
        {assigningOwner ? (
          <SearchableCombobox
            label="Account Owner"
            value={customer.accountOwnerUserId ?? null}
            onChange={assignOwner}
            options={memberships.map((m) => ({ value: m.userId, label: m.user.name }))}
          />
        ) : (
          <div className="detail-field-value">{owner?.user.name ?? 'Unassigned'}</div>
        )}
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Payment Terms</h2>
        <div className="detail-field-value">
          {customer.paymentTerms.replace(/_/g, ' ')}{' '}
          <Badge
            label={customer.paymentTermsSource === 'OVERRIDE' ? 'Override' : 'Inherited'}
            color="neutral"
          />
        </div>
      </div>

      <div className="detail-card-grid">
        <StatTile label="Rate Agreements" value={customer.rateAgreements?.length ?? 0} />
        <StatTile label="Locations" value={customer.locations?.length ?? 0} />
      </div>
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

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="detail-card" style={{ marginBottom: 0 }}>
      <div className="detail-field-label">{label}</div>
      <div style={{ fontSize: 'var(--text-h1-size)', fontWeight: 600 }}>{value}</div>
    </div>
  );
}
