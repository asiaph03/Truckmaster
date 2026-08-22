import { notImplemented } from './notImplemented';

export interface NotificationListFilters {
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
}

/** Typed surface only — real implementations land alongside the app shell (Phase 2). */
export const notificationsApi = {
  list: (_filters?: NotificationListFilters): Promise<unknown[]> =>
    notImplemented('notificationsApi.list'),
  markRead: (_id: string): Promise<unknown> => notImplemented('notificationsApi.markRead'),
  markAllRead: (): Promise<unknown> => notImplemented('notificationsApi.markAllRead'),
};
