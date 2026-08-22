import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Truck,
  Building2,
  Users,
  Receipt,
  FileText,
  BarChart3,
  Settings,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { NAV_ITEMS, type NavItem } from '@tms/shared-constants';
import { usePermissions } from '../hooks/usePermissions';
import './Sidebar.css';

const NAV_CONFIG: Record<NavItem, { label: string; to: string; icon: typeof LayoutDashboard }> = {
  dashboard: { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  loads: { label: 'Loads', to: '/loads', icon: Truck },
  customers: { label: 'Customers', to: '/customers', icon: Building2 },
  carriers: { label: 'Carriers', to: '/carriers', icon: Users },
  billing: { label: 'Billing', to: '/billing', icon: Receipt },
  documents: { label: 'Documents', to: '/documents', icon: FileText },
  reports: { label: 'Reports', to: '/reports', icon: BarChart3 },
  settings: { label: 'Settings', to: '/settings', icon: Settings },
};

const COLLAPSE_STORAGE_KEY = 'tms:sidebar-collapsed';

/** UI_UX_DESIGN.md §5.1.3/§5.3.2/§5.3.8/§5.3.10/§5.3.11. */
export function Sidebar() {
  const { canSeeNav } = usePermissions();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true',
  );

  useEffect(() => {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <nav className="sidebar-nav">
        {/* Permission-aware nav — inaccessible items are hidden entirely, never shown-disabled (§5.3.11). */}
        {NAV_ITEMS.filter((item) => canSeeNav(item)).map((item) => {
          const { label, to, icon: Icon } = NAV_CONFIG[item];
          return (
            <NavLink
              key={item}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `sidebar-item ${isActive ? 'sidebar-item-active' : ''}`}
              title={collapsed ? label : undefined}
            >
              <Icon size={20} strokeWidth={1.5} />
              {!collapsed ? <span className="sidebar-item-label">{label}</span> : null}
            </NavLink>
          );
        })}
      </nav>
      <button
        type="button"
        className="sidebar-collapse-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
      </button>
    </aside>
  );
}
