import type { MembershipRoleName } from '@tms/shared-constants';
import { apiRequest } from './client';

export interface MembershipListItem {
  id: string;
  userId: string;
  status: string;
  user: { id: string; name: string; email: string };
  roles: { role: MembershipRoleName }[];
}

/** `GET /memberships` — used by Customer Overview's "Assign Account Owner" picker. */
export const membershipsApi = {
  list: () => apiRequest<MembershipListItem[]>('/memberships'),
};
