import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Bell, BellOff, Clock } from 'lucide-react';
import { notificationsApi, type AppNotification, type NotificationType } from '../api';
import { Button } from '../components/ui';
import './NotificationBell.css';

/**
 * UI_UX_DESIGN.md §5.3.7 / §5.6.2 (SH-10) — compliance-expiration
 * warnings, plus the Operational Alerts feature's three new types
 * (CHECK_CALL_OVERDUE/CHECK_CALL_DUE_SOON/LOAD_LATE). Empty state:
 * bell-slash icon + "You're all caught up."
 *
 * Operational vs. compliance notifications are visually distinguished by
 * an icon reusing the existing app-wide severity color convention
 * (STATUS_BADGE_MAP's `Load.riskStatus:AT_RISK -> warning` /
 * `DELAYED -> danger`) — compliance notifications keep their current
 * plain-text appearance entirely unchanged.
 */
const NOTIFICATION_STYLE: Partial<
  Record<NotificationType, { icon: typeof Bell; className: string }>
> = {
  CHECK_CALL_OVERDUE: { icon: AlertCircle, className: 'notification-bell-icon-danger' },
  LOAD_LATE: { icon: AlertTriangle, className: 'notification-bell-icon-danger' },
  CHECK_CALL_DUE_SOON: { icon: Clock, className: 'notification-bell-icon-warning' },
};

/**
 * Suggested ordering: CHECK_CALL_OVERDUE, LOAD_LATE, CHECK_CALL_DUE_SOON,
 * then every compliance type (unlisted types default to the same,
 * lowest, priority — never reordered relative to each other). Server
 * ordering (createdAt desc) is preserved as the tie-breaker via a stable
 * sort — no severity column was added to the database for this.
 */
const TYPE_PRIORITY: Partial<Record<NotificationType, number>> = {
  CHECK_CALL_OVERDUE: 0,
  LOAD_LATE: 1,
  CHECK_CALL_DUE_SOON: 2,
};
const DEFAULT_PRIORITY = 3;

function byPriority(a: AppNotification, b: AppNotification): number {
  return (TYPE_PRIORITY[a.type] ?? DEFAULT_PRIORITY) - (TYPE_PRIORITY[b.type] ?? DEFAULT_PRIORITY);
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications', 'list', { pageSize: 10 }],
    queryFn: () => notificationsApi.list({ pageSize: 10 }),
    refetchInterval: 60_000,
  });

  // Decoupled from the paginated list above — an authoritative count so
  // the badge never silently undercounts once more than 10 notifications
  // exist (the list call only ever fetches the most recent 10).
  const { data: unreadCountData } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 60_000,
  });
  const unreadCount = unreadCountData?.count ?? 0;

  const sortedNotifications = [...notifications].sort(byPriority);

  async function handleMarkAllRead() {
    await notificationsApi.markAllRead();
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  async function handleMarkRead(id: string) {
    await notificationsApi.markRead(id);
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  function handleNotificationClick(n: AppNotification) {
    if (!n.read) void handleMarkRead(n.id);
    if (n.relatedEntityType === 'Load' && n.relatedEntityId) {
      setOpen(false);
      navigate(`/loads/${n.relatedEntityId}`);
    }
  }

  return (
    <div className="notification-bell">
      <button
        type="button"
        className="notification-bell-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
      >
        <Bell size={18} strokeWidth={1.5} />
        {unreadCount > 0 ? <span className="notification-bell-badge">{unreadCount}</span> : null}
      </button>
      {open ? (
        <div className="notification-bell-panel">
          <div className="notification-bell-header">
            <span>Notifications</span>
            {unreadCount > 0 ? (
              <Button variant="tertiary" size="sm" onClick={handleMarkAllRead}>
                Mark all as read
              </Button>
            ) : null}
          </div>
          {sortedNotifications.length === 0 ? (
            <div className="notification-bell-empty">
              <BellOff size={24} strokeWidth={1.5} color="var(--neutral-300)" />
              <p>You&apos;re all caught up.</p>
            </div>
          ) : (
            <ul className="notification-bell-list">
              {sortedNotifications.map((n) => {
                const style = NOTIFICATION_STYLE[n.type];
                const Icon = style?.icon;
                const lines = n.message.split('\n');
                return (
                  <li
                    key={n.id}
                    className={`notification-bell-item ${n.read ? '' : 'notification-bell-item-unread'}`}
                    onClick={() => handleNotificationClick(n)}
                  >
                    <div className="notification-bell-item-row">
                      {Icon ? (
                        <Icon
                          size={16}
                          strokeWidth={1.75}
                          className={`notification-bell-icon ${style.className}`}
                        />
                      ) : null}
                      <div className="notification-bell-item-text">
                        {lines.map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
