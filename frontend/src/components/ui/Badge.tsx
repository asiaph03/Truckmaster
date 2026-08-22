import type { BadgeColor } from './statusBadgeMap';
import './Badge.css';

export interface BadgeProps {
  /** Human-readable label — always shown alongside color, never color-only (§5.6 accessibility). */
  label: string;
  color: BadgeColor;
}

/** UI_UX_DESIGN.md §5.2.5 "Status Badges". */
export function Badge({ label, color }: BadgeProps) {
  return <span className={`badge badge-${color}`}>{label}</span>;
}
