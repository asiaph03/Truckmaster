import { useState } from 'react';
import { authApi } from '../api';
import { ApiError } from '../api/errors';
import { useSessionStore } from '../auth/session-store';
import { Button } from '../components/ui';
import './LoginPage.css';

/** Shown when POST /auth/login returns requiresOrganizationSelection: true. */
export function SelectOrganizationPage() {
  const organizations = useSessionStore((s) => s.pendingOrganizations);
  const applySession = useSessionStore((s) => s.applySession);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function selectOrganization(organizationId: string) {
    setPendingId(organizationId);
    setError(null);
    try {
      await authApi.selectOrganization({ organizationId });
      // Same reasoning as LoginPage's auto-select branch: GET /auth/me is
      // the one source of truth for the resulting session, since neither
      // this endpoint's response nor the store (nothing has populated
      // userId yet on this multi-org path) carries the full profile.
      const me = await authApi.me();
      applySession({
        userId: me.id,
        organizationId: me.organizationId,
        roles: me.roles,
        name: me.name,
        email: me.email,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setPendingId(null);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Select organization</h1>
        <p className="login-subtitle">You belong to more than one organization.</p>
        {error ? <div className="login-error">{error}</div> : null}
        {organizations.map((org) => (
          <Button
            key={org.id}
            variant="secondary"
            size="lg"
            loading={pendingId === org.id}
            onClick={() => selectOrganization(org.id)}
            style={{ width: '100%', justifyContent: 'flex-start' }}
          >
            {org.legalName}
          </Button>
        ))}
      </div>
    </div>
  );
}
