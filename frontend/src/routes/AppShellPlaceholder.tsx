import { NAV_ITEMS, type NavItem } from '@tms/shared-constants';
import { authApi } from '../api';
import { useSessionStore } from '../auth/session-store';
import { usePermissions } from '../hooks/usePermissions';
import { Button, Badge } from '../components/ui';
import { useToast } from '../components/ui/toastStore';
import './AppShellPlaceholder.css';

const NAV_LABELS: Record<NavItem, string> = {
  dashboard: 'Dashboard',
  loads: 'Loads',
  customers: 'Customers',
  carriers: 'Carriers',
  billing: 'Billing',
  documents: 'Documents',
  reports: 'Reports',
  settings: 'Settings',
};

/**
 * Phase 1 has no real screens yet (§Build order — Phase 2+ builds the
 * real app shell + screens). This exists only to prove the auth/session/
 * permissions foundation end-to-end: nav visibility per role, current
 * user/org/roles, and logout.
 */
export function AppShellPlaceholder() {
  const userId = useSessionStore((s) => s.userId);
  const organizationId = useSessionStore((s) => s.organizationId);
  const roles = useSessionStore((s) => s.roles);
  const clear = useSessionStore((s) => s.clear);
  const { canSeeNav, isFullVisibility } = usePermissions();
  const toast = useToast();

  async function handleLogout() {
    try {
      await authApi.logout();
    } finally {
      clear();
      toast.info('You have been signed out.');
    }
  }

  return (
    <div className="shell-placeholder">
      <aside className="shell-sidebar">
        <div className="shell-brand">Truck Master TMS</div>
        <nav>
          {NAV_ITEMS.filter((item) => canSeeNav(item)).map((item) => (
            <div key={item} className="shell-nav-item">
              {NAV_LABELS[item]}
            </div>
          ))}
        </nav>
      </aside>
      <main className="shell-main">
        <header className="shell-topbar">
          <span>Organization: {organizationId}</span>
          <Button variant="secondary" size="sm" onClick={handleLogout}>
            Sign out
          </Button>
        </header>
        <div className="shell-content">
          <h1>Phase 1 foundation check</h1>
          <p>User: {userId}</p>
          <p>
            Roles:{' '}
            {roles.map((role) => (
              <Badge key={role} label={role} color="brand" />
            ))}
          </p>
          <p>Full financial visibility: {isFullVisibility() ? 'yes' : 'no'}</p>
          <p className="shell-note">
            No real screens exist yet — Phase 2 builds the app shell and Customers/Carriers/
            Documents; this placeholder only verifies auth, session, nav-permission, and design
            tokens are wired correctly end-to-end.
          </p>
        </div>
      </main>
    </div>
  );
}
