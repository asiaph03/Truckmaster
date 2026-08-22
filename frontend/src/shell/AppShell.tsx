import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { ToastViewport } from '../components/ui';
import './AppShell.css';

/** UI_UX_DESIGN.md §5.3 — replaces Phase 1's AppShellPlaceholder entirely. */
export function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-shell-main">
        <TopBar />
        <main className="app-shell-content">
          <Outlet />
        </main>
      </div>
      <ToastViewport />
    </div>
  );
}
