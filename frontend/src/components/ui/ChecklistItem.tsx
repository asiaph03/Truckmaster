import { Check, AlertTriangle } from 'lucide-react';
import './ChecklistItem.css';

export interface ChecklistItemProps {
  label: string;
  state: 'clean' | 'warning';
  detail?: string;
}

/** UI_UX_DESIGN.md §5.2.5 — Load Closing checklist rows (Workflow 10 §10.1). */
export function ChecklistItem({ label, state, detail }: ChecklistItemProps) {
  return (
    <div className={`checklist-item checklist-${state}`}>
      <span className="checklist-icon">
        {state === 'clean' ? (
          <Check size={16} strokeWidth={2} />
        ) : (
          <AlertTriangle size={16} strokeWidth={1.5} />
        )}
      </span>
      <span className="checklist-label">{label}</span>
      {detail ? <span className="checklist-detail">{detail}</span> : null}
    </div>
  );
}
