import type { ReactNode } from 'react';
import { ChevronUp, ChevronDown, MoreVertical, Inbox } from 'lucide-react';
import { Button } from './Button';
import './DataTable.css';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  width?: string;
  align?: 'left' | 'right';
  /** Right-align + tabular-nums for currency/numeric columns, per §5.2.5. */
  numeric?: boolean;
  frozen?: boolean;
  render: (row: T) => ReactNode;
}

export interface DataTablePagination {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export interface DataTableSort {
  key: string;
  direction: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  emptyAction?: ReactNode;
  selectable?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  rowActions?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  sort?: DataTableSort;
  onSortChange?: (key: string) => void;
  pagination?: DataTablePagination;
}

/**
 * UI_UX_DESIGN.md §5.2.5 "Tables" — dense rows, no zebra striping,
 * status columns render Badge (never raw enum text — caller's `render`
 * is responsible for that), checkbox selection only when `selectable`.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyMessage = 'No results match your filters.',
  emptyAction,
  selectable = false,
  selectedKeys,
  onSelectionChange,
  rowActions,
  onRowClick,
  sort,
  onSortChange,
  pagination,
}: DataTableProps<T>) {
  const allSelected =
    selectable && rows.length > 0 && rows.every((r) => selectedKeys?.has(rowKey(r)));

  function toggleAll() {
    if (!onSelectionChange) return;
    onSelectionChange(allSelected ? new Set() : new Set(rows.map(rowKey)));
  }

  function toggleRow(key: string) {
    if (!onSelectionChange || !selectedKeys) return;
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  }

  return (
    <div className="data-table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            {selectable ? (
              <th className="data-table-checkbox-col">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all rows"
                />
              </th>
            ) : null}
            {columns.map((col) => (
              <th
                key={col.key}
                className={[
                  col.numeric || col.align === 'right' ? 'data-table-align-right' : '',
                  col.frozen ? 'data-table-frozen' : '',
                  onSortChange ? 'data-table-sortable' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={col.width ? { width: col.width } : undefined}
                onClick={() => onSortChange?.(col.key)}
              >
                <span className="data-table-header-label">
                  {col.header}
                  {sort?.key === col.key ? (
                    sort.direction === 'asc' ? (
                      <ChevronUp size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )
                  ) : null}
                </span>
              </th>
            ))}
            {rowActions ? <th className="data-table-actions-col" /> : null}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <tr key={`skeleton-${i}`} className="data-table-skeleton-row">
                {(selectable ? [null, ...columns] : columns).map((_, j) => (
                  <td key={j}>
                    <div className="data-table-skeleton-cell" />
                  </td>
                ))}
                {rowActions ? <td /> : null}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0)}
                className="data-table-empty"
              >
                <Inbox size={28} strokeWidth={1.5} color="var(--neutral-300)" />
                <p>{emptyMessage}</p>
                {emptyAction}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  className={onRowClick ? 'data-table-row-clickable' : undefined}
                  onClick={() => onRowClick?.(row)}
                >
                  {selectable ? (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedKeys?.has(key) ?? false}
                        onChange={() => toggleRow(key)}
                        aria-label="Select row"
                      />
                    </td>
                  ) : null}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={[
                        col.numeric || col.align === 'right'
                          ? 'data-table-align-right tabular-nums'
                          : '',
                        col.frozen ? 'data-table-frozen' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                  {rowActions ? (
                    <td className="data-table-actions-col" onClick={(e) => e.stopPropagation()}>
                      {rowActions(row)}
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {pagination && !loading && rows.length > 0 ? (
        <DataTablePaginationBar {...pagination} />
      ) : null}
    </div>
  );
}

function DataTablePaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: DataTablePagination) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="data-table-pagination">
      <span className="data-table-pagination-summary">
        Showing {start}–{end} of {total}
      </span>
      <div className="data-table-pagination-controls">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          Prev
        </Button>
        <span className="data-table-pagination-page">
          {page} / {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next
        </Button>
        <select
          className="data-table-page-size"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {[25, 50, 100].map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function RowActionsMenu({ children }: { children: ReactNode }) {
  return (
    <div className="data-table-row-actions">
      <button type="button" className="btn btn-icon" aria-label="Row actions">
        <MoreVertical size={16} strokeWidth={1.5} />
      </button>
      <div className="data-table-row-actions-menu">{children}</div>
    </div>
  );
}
