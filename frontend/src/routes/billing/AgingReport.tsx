import { useState } from 'react';
import type { AgingBuckets, AgingReport as AgingReportData } from '../../api';
import { Button, DataTable } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import '../shared/ListPage.css';
import './AgingReport.css';

const BUCKET_ORDER: (keyof AgingBuckets)[] = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'days90plus',
];

const BUCKET_LABELS: Record<keyof AgingBuckets, string> = {
  current: 'Current',
  days1to30: '1–30 Days',
  days31to60: '31–60 Days',
  days61to90: '61–90 Days',
  days90plus: '90+ Days',
};

function formatMoney(value: string): string {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Approved Frontend Phase 5 shape: bucket summary cards + a drill-down
 * table, both rendering the exact same 5-bucket response the backend
 * returns (`{ buckets, grandTotal }`) — no per-invoice/per-load line
 * items exist on this endpoint to drill into, so "drill-down" here means
 * the standard list-page-convention detailed table beneath the at-a-
 * glance cards, not a deeper level of data than the backend provides.
 * Shared by ArAgingPage and ApAgingPage — identical shape, different
 * data source and bucket-basis caption per Decision Log D14.
 *
 * Phase 21 (Reports Library) — `onExport` is optional so this component's
 * existing contract is unchanged for any other caller; both current
 * callers (ArAgingPage/ApAgingPage) pass it, per the approved decision
 * that AR/AP Aging participate in the library's CSV export behavior
 * without a second report implementation.
 */
export function AgingReport({
  title,
  basisNote,
  data,
  isLoading,
  onExport,
}: {
  title: string;
  basisNote: string;
  data: AgingReportData | undefined;
  isLoading: boolean;
  onExport?: () => Promise<void>;
}) {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const rows = data ? BUCKET_ORDER.map((key) => ({ key, ...data.buckets[key] })) : [];

  async function handleExport() {
    if (!onExport) return;
    setExporting(true);
    try {
      await onExport();
    } catch {
      toast.danger('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="list-page-header">
        <div>
          <h1 className="list-page-title">{title}</h1>
          <p style={{ margin: 0, color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
            {basisNote}
          </p>
        </div>
        {onExport ? (
          <Button variant="secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        ) : null}
      </div>

      <div className="aging-bucket-cards">
        {BUCKET_ORDER.map((key) => (
          <div key={key} className="aging-bucket-card">
            <div className="aging-bucket-card-label">{BUCKET_LABELS[key]}</div>
            <div className="aging-bucket-card-total">
              {data ? formatMoney(data.buckets[key].total) : '—'}
            </div>
            <div className="aging-bucket-card-count">
              {data
                ? `${data.buckets[key].count} item${data.buckets[key].count === 1 ? '' : 's'}`
                : ''}
            </div>
          </div>
        ))}
        <div className="aging-bucket-card aging-bucket-card-grand-total">
          <div className="aging-bucket-card-label">Grand Total</div>
          <div className="aging-bucket-card-total">{data ? formatMoney(data.grandTotal) : '—'}</div>
        </div>
      </div>

      <DataTable
        loading={isLoading}
        rows={rows}
        rowKey={(r) => r.key}
        emptyMessage="No outstanding balances."
        columns={[
          { key: 'bucket', header: 'Bucket', render: (r) => BUCKET_LABELS[r.key] },
          { key: 'count', header: 'Items', numeric: true, render: (r) => r.count },
          { key: 'total', header: 'Total', numeric: true, render: (r) => formatMoney(r.total) },
        ]}
      />
    </div>
  );
}
