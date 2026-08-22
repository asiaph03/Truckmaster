import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { authApi } from '../api';
import { useSessionStore, resetContextForOrganizationSwitch } from '../auth/session-store';
import './OrgSwitcher.css';

/**
 * UI_UX_DESIGN.md §5.3.3 — renders only if the user has >1 ACTIVE
 * membership. See session-store.ts's `availableOrganizations` doc
 * comment for why that list isn't always available (no backend
 * "list my organizations" endpoint outside the login response).
 */
export function OrgSwitcher() {
  const organizations = useSessionStore((s) => s.availableOrganizations);
  const currentOrgId = useSessionStore((s) => s.organizationId);
  const applySession = useSessionStore((s) => s.applySession);
  const userId = useSessionStore((s) => s.userId);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  if (organizations.length <= 1) return null;

  const current = organizations.find((o) => o.id === currentOrgId);

  async function handleSwitch(organizationId: string) {
    if (organizationId === currentOrgId) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      resetContextForOrganizationSwitch();
      const session = await authApi.switchOrganization({ organizationId });
      applySession({
        userId: userId ?? '',
        organizationId: session.organizationId,
        roles: session.roles,
      });
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }

  return (
    <div className="org-switcher">
      <button
        type="button"
        className="org-switcher-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
      >
        <span className="org-switcher-name">{current?.legalName ?? 'Select organization'}</span>
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>
      {open ? (
        <div className="org-switcher-panel">
          {organizations.map((org) => (
            <button
              key={org.id}
              type="button"
              className={`org-switcher-option ${org.id === currentOrgId ? 'org-switcher-option-active' : ''}`}
              onClick={() => handleSwitch(org.id)}
            >
              {org.legalName}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
