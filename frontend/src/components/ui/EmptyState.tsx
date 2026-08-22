import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import './EmptyState.css';

export interface EmptyStateProps {
  message: string;
  action?: ReactNode;
  icon?: ReactNode;
}

/** UI_UX_DESIGN.md §5.2.5 "Empty States" — standalone (non-table) version. */
export function EmptyState({ message, action, icon }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon ?? <Inbox size={28} strokeWidth={1.5} color="var(--neutral-300)" />}
      <p className="empty-state-message">{message}</p>
      {action}
    </div>
  );
}
