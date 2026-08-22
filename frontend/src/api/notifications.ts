import { apiRequest } from './client';

export type NotificationType =
  | 'COMPLIANCE_EXPIRING_30_DAY'
  | 'COMPLIANCE_EXPIRING_15_DAY'
  | 'COMPLIANCE_EXPIRING_7_DAY'
  | 'CHECK_CALL_OVERDUE';

export interface AppNotification {
  id: string;
  type: NotificationType;
  message: string;
  isRead: boolean;
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

  markRead: (id: string) =>
    apiRequest<{ success: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),

  markAllRead: () =>
    apiRequest<{ success: boolean }>('/notifications/mark-all-read', { method: 'POST' }),
};
