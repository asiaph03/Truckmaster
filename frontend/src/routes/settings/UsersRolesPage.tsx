import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { MEMBERSHIP_ROLES, type MembershipRoleName } from '@tms/shared-constants';
import {
  membershipsApi,
  type InviteMemberRequest,
  type MembershipListItem,
  type MembershipStatus,
} from '../../api';
import { ApiError } from '../../api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Modal,
  ModalFooter,
  TextField,
} from '../../components/ui';
import type { BadgeColor } from '../../components/ui/statusBadgeMap';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/ListPage.css';

const ROLE_LABELS: Record<MembershipRoleName, string> = {
  ADMIN: 'Admin',
  OPERATIONS_MANAGER: 'Operations Manager',
  DISPATCHER: 'Dispatcher',
  SALES_BOOKING: 'Sales/Booking',
  ACCOUNTING: 'Accounting',
  COMPLIANCE_REVIEWER: 'Compliance Reviewer',
};

// Not from the locked UI_UX_DESIGN.md §5.2.1 badge table (Settings screens
// were never in that pass's critical-screen set) — a small local mapping
// kept out of the shared, doc-ported statusBadgeMap.ts rather than adding
// undesigned entries to a file whose header says "ported verbatim".
const STATUS_COLOR: Record<MembershipStatus, BadgeColor> = {
  INVITED: 'warning',
  ACTIVE: 'success',
  CANCELLED: 'neutral',
  INACTIVE: 'neutral',
  EXPIRED: 'danger',
};

/**
 * Approved Frontend Phase 5 scope: invite, resend, cancel, and deactivate
 * only — the backend (`MembershipsController`) has no role-change
 * endpoint on an existing member, so this screen deliberately has no
 * "Edit Roles" action. Roles are shown read-only after invite, with an
 * explicit caption saying so, rather than a control that would always
 * 404.
 *
 * `GET /memberships` itself carries no backend role restriction (it's
 * also used by non-Admin screens — the Dispatch Board's dispatcher
 * filter, Customer Overview's Account Owner picker) — only invite/
 * resend/cancel/deactivate are Admin-only. Without a page-level gate
 * here, any authenticated role could reach the full member roster
 * (names/emails/role assignments) by navigating straight to `/settings`,
 * even though the nav item itself is hidden for them. Gated with the
 * locked §5.3.12 "permission-denied route" treatment — centered lock
 * icon, no retry button — rather than silently rendering the list.
 */
export function UsersRolesPage() {
  const { can } = usePermissions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [cancelling, setCancelling] = useState<MembershipListItem | null>(null);
  const [deactivating, setDeactivating] = useState<MembershipListItem | null>(null);

  const canManage = can('manageMemberships');

  const { data: memberships = [], isLoading } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
    enabled: canManage,
  });

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteMemberRequest>({ defaultValues: { roles: [] } });

  function afterMutation() {
    queryClient.invalidateQueries({ queryKey: ['memberships'] });
  }

  async function onInvite(values: InviteMemberRequest) {
    try {
      await membershipsApi.invite(values);
      toast.success(`Invitation sent to ${values.email}.`);
      setInviting(false);
      reset({ roles: [] });
      afterMutation();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onResend(membership: MembershipListItem) {
    try {
      await membershipsApi.resend(membership.id);
      toast.success(`Invitation re-sent to ${membership.user.email}.`);
      afterMutation();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onCancel() {
    if (!cancelling) return;
    try {
      await membershipsApi.cancel(cancelling.id);
      toast.success(`Invitation to ${cancelling.user.email} cancelled.`);
      setCancelling(null);
      afterMutation();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onDeactivate() {
    if (!deactivating) return;
    try {
      await membershipsApi.deactivate(deactivating.id);
      toast.success(`${deactivating.user.name} deactivated.`);
      setDeactivating(null);
      afterMutation();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  if (!canManage) {
    return (
      <EmptyState
        icon={<Lock size={28} strokeWidth={1.5} color="var(--neutral-300)" />}
        message="You don't have access to this page."
      />
    );
  }

  return (
    <div>
      <div className="list-page-header">
        <div>
          <h1 className="list-page-title">Users & Roles</h1>
          <p style={{ margin: 0, color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
            Invite, resend, cancel, or deactivate. Changing an existing member's roles isn't
            supported yet — cancel and re-invite instead.
          </p>
        </div>
        <Button
          onClick={() => {
            reset({ roles: [] });
            setInviting(true);
          }}
        >
          + Invite User
        </Button>
      </div>

      <DataTable
        loading={isLoading}
        rows={memberships}
        rowKey={(m) => m.id}
        emptyMessage="No members yet."
        columns={[
          { key: 'name', header: 'Name', render: (m) => m.user.name },
          { key: 'email', header: 'Email', render: (m) => m.user.email },
          {
            key: 'roles',
            header: 'Roles',
            render: (m) => (
              <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                {m.roles.map((r) => (
                  <Badge key={r.role} label={ROLE_LABELS[r.role]} color="neutral" />
                ))}
              </div>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            render: (m) => <Badge label={m.status} color={STATUS_COLOR[m.status]} />,
          },
          {
            key: 'actions',
            header: '',
            render: (m) => (
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                {m.status === 'INVITED' ? (
                  <>
                    <Button variant="tertiary" size="sm" onClick={() => onResend(m)}>
                      Resend
                    </Button>
                    <Button variant="tertiary" size="sm" onClick={() => setCancelling(m)}>
                      Cancel
                    </Button>
                  </>
                ) : null}
                {m.status === 'ACTIVE' ? (
                  <Button variant="destructive" size="sm" onClick={() => setDeactivating(m)}>
                    Deactivate
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]}
      />

      <Modal
        open={inviting}
        title="Invite User"
        onClose={() => setInviting(false)}
        footer={
          <ModalFooter
            onCancel={() => setInviting(false)}
            onConfirm={handleSubmit(onInvite)}
            confirmLabel="Send Invitation"
            loading={isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onInvite)}>
          <TextField
            label="Email"
            type="email"
            required
            error={errors.email ? 'Email is required.' : undefined}
            {...register('email', { required: true })}
          />
          <div className="form-field">
            <label className="form-field-label">Roles</label>
            <Controller
              name="roles"
              control={control}
              rules={{ validate: (v) => (v && v.length > 0) || 'Select at least one role.' }}
              render={({ field }) => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  {MEMBERSHIP_ROLES.map((role) => (
                    <label
                      key={role}
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                    >
                      <input
                        type="checkbox"
                        checked={field.value?.includes(role) ?? false}
                        onChange={(e) => {
                          const next = new Set(field.value ?? []);
                          if (e.target.checked) next.add(role);
                          else next.delete(role);
                          field.onChange([...next]);
                        }}
                      />
                      {ROLE_LABELS[role]}
                    </label>
                  ))}
                </div>
              )}
            />
            {errors.roles ? (
              <div style={{ color: 'var(--danger-600)', fontSize: 'var(--text-caption-size)' }}>
                {errors.roles.message}
              </div>
            ) : null}
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel Invitation"
        message={`This cancels the pending invitation to ${cancelling?.user.email ?? ''}.`}
        confirmLabel="Cancel Invitation"
        confirmVariant="destructive"
        onCancel={() => setCancelling(null)}
        onConfirm={onCancel}
      />

      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate User"
        message={`This deactivates ${deactivating?.user.name ?? ''}. They will no longer be able to sign in.`}
        confirmLabel="Deactivate"
        confirmVariant="destructive"
        onCancel={() => setDeactivating(null)}
        onConfirm={onDeactivate}
      />
    </div>
  );
}
