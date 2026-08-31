import { OrgSwitcher } from './OrgSwitcher';
import { GlobalSearch } from './GlobalSearch';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { EasternClock } from './EasternClock';
import './TopBar.css';

/**
 * UI_UX_DESIGN.md §5.3.1 — 56px, left→right: logo, org switcher …
 * Eastern Time clock, search, notifications, avatar. The clock is
 * purely additive — Search/notifications/avatar keep their existing
 * order and behavior unchanged.
 */
export function TopBar() {
  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <span className="top-bar-logo">Truck Master TMS</span>
        <OrgSwitcher />
      </div>
      <div className="top-bar-right">
        <EasternClock />
        <GlobalSearch />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
