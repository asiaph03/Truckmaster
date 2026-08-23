import './FilterChip.css';

export interface FilterChipProps {
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}

/** UI_UX_DESIGN.md §5.4.1 — Dispatch Board's quick-filter chip row (e.g. "Pickups next 4h (3)"). */
export function FilterChip({ label, count, active = false, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      className={`filter-chip ${active ? 'filter-chip-active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
      {typeof count === 'number' ? <span className="filter-chip-count">{count}</span> : null}
    </button>
  );
}
