import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { notificationsApi } from '../api';
import { Button } from '../components/ui';
import './NotificationBell.css';

/**
 * UI_UX_DESIGN.md §5.3.7 / §5.6.2 (SH-10). Only V1 notification type is
 * compliance-expiration warnings (Workflow 3 §3.10). Empty state:
 * bell-slash icon + "You're all caught up."
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications', { unreadOnly: false, pageSize: 10 }],
    queryFn: () => notificationsApi.list({ pageSize: 10 }),
    refetchInterval: 60_000,
  });

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  async function handleMarkAllRead() {
    await notificationsApi.markAllRead();
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  async function handleMarkRead(id: string) {
    await notificationsApi.markRead(id);
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
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
          {notifications.length === 0 ? (
            <div className="notification-bell-empty">
              <BellOff size={24} strokeWidth={1.5} color="var(--neutral-300)" />
              <p>You&apos;re all caught up.</p>
            </div>
          ) : (
            <ul className="notification-bell-list">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`notification-bell-item ${n.isRead ? '' : 'notification-bell-item-unread'}`}
                  onClick={() => !n.isRead && handleMarkRead(n.id)}
                >
                  {n.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
