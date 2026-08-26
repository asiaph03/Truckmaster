import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '../../components/ui';

/**
 * Frontend Phase 14 — the smallest UI change that distinguishes
 * `/settings` (Users & Roles) from `/settings/organization`: the
 * existing `Tabs` component (§5.2.5), wired to route navigation instead
 * of local state, mirroring how Dispatch Board already switches between
 * Table/Kanban/Calendar. No new nav chrome invented.
 */
export function SettingsTabs() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeKey = location.pathname.startsWith('/settings/organization')
    ? 'organization'
    : 'users';

  return (
    <Tabs
      tabs={[
        { key: 'users', label: 'Users & Roles' },
        { key: 'organization', label: 'Organization' },
      ]}
      activeKey={activeKey}
      onChange={(key) => navigate(key === 'organization' ? '/settings/organization' : '/settings')}
    />
  );
}
