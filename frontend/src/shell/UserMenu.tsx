import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { authApi } from '../api';
import { useSessionStore } from '../auth/session-store';
import { Modal, ModalFooter, TextField } from '../components/ui';
import { useToast } from '../components/ui/toastStore';
import './UserMenu.css';

interface EditProfileValues {
  name: string;
  password?: string;
}

/**
 * UI_UX_DESIGN.md §5.3.4 + §5.6.2 (SH-9) — initials avatar, role
 * badge(s), Log out; SH-9 added minimal self-service name/password
 * editing to this menu.
 */
export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const roles = useSessionStore((s) => s.roles);
  const name = useSessionStore((s) => s.name);
  const email = useSessionStore((s) => s.email);
  const clear = useSessionStore((s) => s.clear);
  const applySession = useSessionStore((s) => s.applySession);
  const userId = useSessionStore((s) => s.userId);
  const organizationId = useSessionStore((s) => s.organizationId);
  const toast = useToast();

  const initialsSource = name || email || '?';
  const initials = initialsSource
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const { register, handleSubmit, formState } = useForm<EditProfileValues>({
    values: { name: name ?? '', password: '' },
  });

  async function onSubmitProfile(values: EditProfileValues) {
    await authApi.updateMe({
      name: values.name || undefined,
      password: values.password || undefined,
    });
    applySession({ userId: userId ?? '', organizationId, roles, name: values.name, email });
    toast.success('Profile updated.');
    setEditing(false);
  }

  async function handleLogout() {
    try {
      await authApi.logout();
    } finally {
      clear();
    }
  }

  return (
    <div className="user-menu">
      <button
        type="button"
        className="user-menu-avatar"
        onClick={() => setOpen((o) => !o)}
        aria-label="User menu"
      >
        {initials}
      </button>
      {open ? (
        <div className="user-menu-panel">
          <div className="user-menu-identity">
            <div className="user-menu-name">{name}</div>
            <div className="user-menu-email">{email}</div>
          </div>
          <div className="user-menu-roles">
            {roles.map((role) => (
              <span key={role} className="user-menu-role-badge">
                {role}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="user-menu-item"
            onClick={() => {
              setEditing(true);
              setOpen(false);
            }}
          >
            Edit Profile
          </button>
          <button type="button" className="user-menu-item" onClick={handleLogout}>
            Log out
          </button>
        </div>
      ) : null}

      <Modal
        open={editing}
        title="Edit Profile"
        onClose={() => setEditing(false)}
        footer={
          <ModalFooter
            onCancel={() => setEditing(false)}
            onConfirm={handleSubmit(onSubmitProfile)}
            confirmLabel="Save"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmitProfile)}>
          <TextField label="Name" {...register('name')} />
          <TextField
            label="New Password"
            type="password"
            helperText="Leave blank to keep your current password."
            {...register('password')}
          />
        </form>
      </Modal>
    </div>
  );
}
