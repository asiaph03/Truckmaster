import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import './BulkActionBar.css';

export interface BulkActionBarProps {
  selectedCount: number;
  onClear: () => void;
  children: ReactNode;
}

/** UI_UX_DESIGN.md §5.4.1 — replaces the quick-filter chip row when ≥1 row is selected. */
export function BulkActionBar({ selectedCount, onClear, children }: BulkActionBarProps) {
  return (
    <div className="bulk-action-bar">
      <span className="bulk-action-bar-count">{selectedCount} selected</span>
      <div className="bulk-action-bar-actions">{children}</div>
      <Button variant="tertiary" size="sm" onClick={onClear}>
        <X size={14} strokeWidth={1.5} /> Clear
      </Button>
    </div>
  );
}
