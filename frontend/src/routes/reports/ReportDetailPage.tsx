import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { customersApi, carriersApi } from '../../api';
import { Button, DataTable, EmptyState } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { REPORT_DEFINITIONS, type ReportFilterState } from './reportDefinitions';
import '../shared/ListPage.css';
import './ReportDetailPage.css';

function defaultDateRange(): { dateFrom: string; dateTo: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { dateFrom: from.toISOString().slice(0, 10), dateTo: to.toISOString().slice(0, 10) };
}

/**
 * Phase 21 (Reports Library) — one generic report-run screen, driven
 * entirely by `reportDefinitions.tsx`, structured directly on
 * `LoadSearchPage`/`DocumentCenterPage`'s existing precedent (filter
 * toolbar → `DataTable` → Export CSV), per the approved "avoid inventing
 * a visual system" requirement. Locked sitemap route: `/reports/:reportId`.
 */
export function ReportDetailPage() {
  const { reportId = '' } = useParams();
  const toast = useToast();
  const definition = REPORT_DEFINITIONS[reportId];

  const hasRequiredDateRange = definition?.filterFields.some(
    (f) => f.type === 'date' && f.required,
  );

  const [filters, setFilters] = useState<ReportFilterState>(() => {
    const initial: ReportFilterState = {};
    if (hasRequiredDateRange) {
      Object.assign(initial, defaultDateRange());
    }
    for (const field of definition?.filterFields ?? []) {
      if (field.required && field.type === 'select' && field.options?.length) {
        initial[field.key] = field.options[0].value;
      }
    }
    return initial;
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [compare, setCompare] = useState(false);
  const [exporting, setExporting] = useState(false);

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', {}],
    queryFn: () => customersApi.list(),
    enabled: Boolean(definition?.filterFields.some((f) => f.optionsSource === 'customers')),
  });
  const { data: carriers = [] } = useQuery({
    queryKey: ['carriers', {}],
    queryFn: () => carriersApi.list(),
    enabled: Boolean(definition?.filterFields.some((f) => f.optionsSource === 'carriers')),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['reports', reportId, filters, page, pageSize, compare],
    queryFn: () => definition!.fetch(filters, { page, pageSize }, compare),
    enabled: Boolean(definition),
  });

  function resetToPage1(key: string, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  async function handleExport() {
    if (!definition) return;
    setExporting(true);
    try {
      await definition.exportCsv(filters);
    } catch {
      toast.danger('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  const optionsForField = useMemo(
    () => ({
      customers: customers.map((c) => ({ value: c.id, label: c.legalName })),
      carriers: carriers.map((c) => ({ value: c.id, label: c.legalName })),
    }),
    [customers, carriers],
  );

  if (!definition) {
    return <EmptyState message="This report does not exist." />;
  }

  const items = data?.items ?? [];

  return (
    <div>
      <div className="list-page-header">
        <div>
          <h1 className="list-page-title">{definition.title}</h1>
          <p style={{ margin: 0, color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
            {definition.basisNote}
          </p>
        </div>
        <Button variant="secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      <div className="list-page-toolbar">
        {definition.filterFields.map((field) => {
          if (field.type === 'date') {
            return (
              <label key={field.key} className="report-detail-date-filter">
                {field.label}
                <input
                  type="date"
                  value={filters[field.key] ?? ''}
                  onChange={(e) => resetToPage1(field.key, e.target.value)}
                />
              </label>
            );
          }
          const options =
            field.options ??
            (field.optionsSource
              ? [
                  { value: '', label: `All ${field.label.toLowerCase()}s` },
                  ...optionsForField[field.optionsSource],
                ]
              : []);
          return (
            <select
              key={field.key}
              className="field-select list-page-filter"
              value={filters[field.key] ?? ''}
              onChange={(e) => resetToPage1(field.key, e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        })}
        {definition.supportsCompare ? (
          <label className="report-detail-compare-toggle">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => {
                setCompare(e.target.checked);
                setPage(1);
              }}
            />
            Compare to previous period
          </label>
        ) : null}
      </div>

      {'truncated' in (data ?? {}) && (data as { truncated?: boolean })?.truncated ? (
        <p style={{ color: 'var(--warning-600, #b45309)', fontSize: 'var(--text-small-size)' }}>
          Results were capped — narrow your date range for a complete export.
        </p>
      ) : null}

      <DataTable
        loading={isLoading}
        rows={items}
        rowKey={definition.rowKey}
        emptyMessage="No data matches your filters."
        pagination={
          definition.paginated
            ? {
                page,
                pageSize,
                total: data?.total ?? 0,
                onPageChange: setPage,
                onPageSizeChange: (size) => {
                  setPageSize(size);
                  setPage(1);
                },
              }
            : undefined
        }
        columns={definition.columns.map((col) => ({
          key: col.key,
          header: col.header,
          numeric: col.numeric,
          render: col.render,
        }))}
      />

      {compare &&
      data &&
      'previousPeriod' in data &&
      (data as { previousPeriod?: unknown[] }).previousPeriod ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <h2 className="detail-card-title">Previous Period</h2>
          <DataTable
            rows={(data as { previousPeriod: Record<string, unknown>[] }).previousPeriod}
            rowKey={definition.rowKey}
            emptyMessage="No data for the previous period."
            columns={definition.columns.map((col) => ({
              key: col.key,
              header: col.header,
              numeric: col.numeric,
              render: col.render,
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}
