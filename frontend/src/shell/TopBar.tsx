import { OrgSwitcher } from './OrgSwitcher';
import { GlobalSearch } from './GlobalSearch';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { EasternClock } from './EasternClock';
import './TopBar.css';

/**
 * UI_UX_DESIGN.md §5.3.1 — 56px, left→right: org switcher, Eastern Time
 * clock, search, notifications, avatar. The text logo previously shown
 * here was removed in favor of the TruckMaster logo now at the top of
 * the sidebar, which is the sole application branding element.
 */
export function TopBar() {
  return (
    <header className="top-bar">
      <div className="top-bar-left">
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
