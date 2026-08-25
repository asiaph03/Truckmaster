import { apiRequest } from './client';

export type CommunicationDirection = 'INBOUND' | 'OUTBOUND';

export interface InternalNote {
  id: string;
  loadId: string;
  authorUserId: string;
  content: string;
  createdAt: string;
}

export interface CommunicationActivity {
  id: string;
  loadId: string;
  loggedByUserId: string;
  activityType: string;
  direction: CommunicationDirection | null;
  contactPerson: string | null;
  notes: string;
  occurredAt: string;
  createdAt: string;
}

export interface AuditActivityEntry {
  id: string;
  action: string;
  entityType: string;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  actorUserId: string | null;
  actorType: string;
  createdAt: string;
}

export type ActivityTimelineEntry =
  | ({ type: 'NOTE'; timestamp: string } & InternalNote)
  | ({ type: 'COMMUNICATION'; timestamp: string } & CommunicationActivity)
  | ({ type: 'AUDIT'; timestamp: string } & AuditActivityEntry);

export interface CreateInternalNoteRequest {
  content: string;
}

export interface CreateCommunicationActivityRequest {
  activityType: string;
  direction?: CommunicationDirection;
  contactPerson?: string;
  notes: string;
  occurredAt?: string;
}

/** Load Detail's Activity History tab (UI_UX_DESIGN.md §5.4.4, Decision LD-6). */
export const activityApi = {
  getHistory: (loadId: string) =>
    apiRequest<ActivityTimelineEntry[]>(`/loads/${loadId}/activity-history`),

  addInternalNote: (loadId: string, body: CreateInternalNoteRequest) =>
    apiRequest<InternalNote>(`/loads/${loadId}/internal-notes`, { method: 'POST', body }),

  logCommunicationActivity: (loadId: string, body: CreateCommunicationActivityRequest) =>
    apiRequest<CommunicationActivity>(`/loads/${loadId}/communication-activities`, {
      method: 'POST',
      body,
    }),
};
