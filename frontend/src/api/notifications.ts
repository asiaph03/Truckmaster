import { apiRequest } from './client';

export type NotificationType =
  | 'COMPLIANCE_EXPIRING_30_DAY'
  | 'COMPLIANCE_EXPIRING_15_DAY'
  | 'COMPLIANCE_EXPIRING_7_DAY'
  | 'CHECK_CALL_OVERDUE'
  | 'CHECK_CALL_DUE_SOON'
  | 'LOAD_LATE';

export interface AppNotification {
  id: string;
  type: NotificationType;
  message: string;
  // Matches the backend's actual field name (`Notification.read` in
  // schema.prisma) — this was previously `isRead` here, which the API
  // never actually returned, so every notification silently rendered and
  // counted as unread regardless of its real state. Never rename the
  // backend field to match a frontend convention; fix the frontend to
  // match the real contract instead.
  read: boolean;
  relatedEntityType?: string;
  relatedEntityId?: string;
  createdAt: string;
}

export interface NotificationListFilters {
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export const notificationsApi = {
  list: (filters?: NotificationListFilters) =>
    apiRequest<AppNotification[]>('/notifications', { query: filters }),

  // Operational Alerts feature — an authoritative unread count, decoupled
  // from the paginated `list` call above (which the bell only ever fetches
  // pageSize: 10) so the badge never silently undercounts once more than
  // 10 notifications exist.
  unreadCount: () => apiRequest<{ count: number }>('/notifications/unread-count'),

  markRead: (id: string) =>
    apiRequest<{ success: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),

  markAllRead: () =>
    apiRequest<{ success: boolean }>('/notifications/mark-all-read', { method: 'POST' }),
};
