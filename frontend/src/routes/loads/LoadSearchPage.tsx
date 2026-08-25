import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { EQUIPMENT_TYPES } from '@tms/shared-constants';
import {
  carriersApi,
  customersApi,
  loadsApi,
  membershipsApi,
  type LoadSearchFilters,
  type LoadSearchSort,
  type LoadSummary,
} from '../../api';
import { Badge, Button, DataTable, type DataTableSort } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { useToast } from '../../components/ui/toastStore';
import {
  firstPickupDate,
  formatDateShort,
  lastDeliveryDate,
  originDestination,
} from './loadDerived';
import '../shared/ListPage.css';
import './LoadSearchPage.css';

const EQUIPMENT_OPTIONS = EQUIPMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));
const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'BOOKED', label: 'Booked' },
  { value: 'CARRIER_SOURCING', label: 'Carrier Sourcing' },
  { value: 'CARRIER_ASSIGNED', label: 'Carrier Assigned' },
  { value: 'RATE_CONFIRMATION', label: 'Rate Confirmation' },
  { value: 'DISPATCHED', label: 'Dispatched' },
  { value: 'PICKUP', label: 'Pickup' },
  { value: 'IN_TRANSIT', label: 'In Transit' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'CLOSED', label: 'Closed' },
];
const RISK_OPTIONS = [
  { value: '', label: 'All risk levels' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'AT_RISK', label: 'At Risk' },
  { value: 'DELAYED', label: 'Delayed' },
];

/** Only these 3 columns are locked as sortable (approved decision #5) — every other header click is a no-op. */
const SORTABLE_KEYS: LoadSearchSort[] = ['loadNumber', 'pickupDate', 'deliveryDate'];

/**
 * UI_UX_DESIGN.md §5.4.1 cross-reference — Frontend Phase 13, approved
 * scope: a dedicated all-loads (including Closed), filterable, searchable,
 * paginated, CSV-exportable screen at the locked `/loads/search` path.
 * Deliberately does not reuse DispatchBoardPage's own state/query — this
 * screen talks to `GET /loads/search`, never `GET /loads`, so Dispatch
 * Board's behavior is provably unaffected.
 */
export function LoadSearchPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [status, setStatus] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [carrierId, setCarrierId] = useState('');
  const [dispatcherId, setDispatcherId] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [riskStatus, setRiskStatus] = useState('');
  const [pickupFrom, setPickupFrom] = useState('');
  const [pickupTo, setPickupTo] = useState('');
  const [deliveryFrom, setDeliveryFrom] = useState('');
  const [deliveryTo, setDeliveryTo] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<DataTableSort | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [exporting, setExporting] = useState(false);

  const filters: LoadSearchFilters = useMemo(
    () => ({
      status: status || undefined,
      customerId: customerId || undefined,
      carrierId: carrierId || undefined,
      dispatcherId: dispatcherId || undefined,
      equipmentType: equipmentType || undefined,
      riskStatus: (riskStatus || undefined) as LoadSearchFilters['riskStatus'],
      pickupFrom: pickupFrom || undefined,
      pickupTo: pickupTo || undefined,
      deliveryFrom: deliveryFrom || undefined,
      deliveryTo: deliveryTo || undefined,
      q: q.trim() || undefined,
      sort: sort?.key as LoadSearchSort | undefined,
      sortDirection: sort?.direction,
      page,
      pageSize,
    }),
    [
      status,
      customerId,
      carrierId,
      dispatcherId,
      equipmentType,
      riskStatus,
      pickupFrom,
      pickupTo,
      deliveryFrom,
      deliveryTo,
      q,
      sort,
      page,
      pageSize,
    ],
  );

  const { data, isLoading } = useQuery({
    queryKey: ['loads-search', filters],
    queryFn: () => loadsApi.search(filters),
  });
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', {}],
    queryFn: () => customersApi.list(),
  });
  const { data: carriers = [] } = useQuery({
    queryKey: ['carriers', {}],
    queryFn: () => carriersApi.list(),
  });
  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
  });

  const customerName = (id: string) => customers.find((c) => c.id === id)?.legalName ?? id;
  const carrierName = (id?: string) =>
    id ? (carriers.find((c) => c.id === id)?.legalName ?? id) : '—';
  const dispatcherName = (id?: string) =>
    id ? (memberships.find((m) => m.userId === id)?.user.name ?? id) : 'Unassigned';

  function resetToPage1<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
    };
  }
  const onStatusChange = resetToPage1(setStatus);
  const onCustomerChange = resetToPage1(setCustomerId);
  const onCarrierChange = resetToPage1(setCarrierId);
  const onDispatcherChange = resetToPage1(setDispatcherId);
  const onEquipmentChange = resetToPage1(setEquipmentType);
  const onRiskChange = resetToPage1(setRiskStatus);
  const onPickupFromChange = resetToPage1(setPickupFrom);
  const onPickupToChange = resetToPage1(setPickupTo);
  const onDeliveryFromChange = resetToPage1(setDeliveryFrom);
  const onDeliveryToChange = resetToPage1(setDeliveryTo);
  const onQChange = resetToPage1(setQ);

  function handleSortChange(key: string) {
    if (!SORTABLE_KEYS.includes(key as LoadSearchSort)) return;
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
    setPage(1);
  }

  async function handleExport() {
    setExporting(true);
    try {
      await loadsApi.exportSearchCsv(filters);
    } catch {
      toast.danger('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Load Search</h1>
        <Button variant="secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      <div className="list-page-toolbar">
        <div className="list-page-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            placeholder="Search Load #, Customer, Carrier, or Origin/Destination…"
            value={q}
            onChange={(e) => onQChange(e.target.value)}
          />
        </div>
        <select
          className="field-select list-page-filter"
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={customerId}
          onChange={(e) => onCustomerChange(e.target.value)}
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.legalName}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={carrierId}
          onChange={(e) => onCarrierChange(e.target.value)}
        >
          <option value="">All carriers</option>
          {carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.legalName}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={dispatcherId}
          onChange={(e) => onDispatcherChange(e.target.value)}
        >
          <option value="">All dispatchers</option>
          {memberships.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.user.name}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={equipmentType}
          onChange={(e) => onEquipmentChange(e.target.value)}
        >
          <option value="">All equipment</option>
          {EQUIPMENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="field-select list-page-filter"
          value={riskStatus}
          onChange={(e) => onRiskChange(e.target.value)}
        >
          {RISK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="list-page-toolbar">
        <label className="load-search-date-filter">
          Pickup from
          <input
            type="date"
            value={pickupFrom}
            onChange={(e) => onPickupFromChange(e.target.value)}
          />
        </label>
        <label className="load-search-date-filter">
          to
          <input type="date" value={pickupTo} onChange={(e) => onPickupToChange(e.target.value)} />
        </label>
        <label className="load-search-date-filter">
          Delivery from
          <input
            type="date"
            value={deliveryFrom}
            onChange={(e) => onDeliveryFromChange(e.target.value)}
          />
        </label>
        <label className="load-search-date-filter">
          to
          <input
            type="date"
            value={deliveryTo}
            onChange={(e) => onDeliveryToChange(e.target.value)}
          />
        </label>
      </div>

      <DataTable
        loading={isLoading}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        onRowClick={(row) => navigate(`/loads/${row.id}`)}
        emptyMessage="No loads match your filters."
        sort={sort}
        onSortChange={handleSortChange}
        pagination={{
          page,
          pageSize,
          total: data?.total ?? 0,
          onPageChange: setPage,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setPage(1);
          },
        }}
        columns={[
          { key: 'loadNumber', header: 'Load #', render: (r: LoadSummary) => r.loadNumber },
          { key: 'customer', header: 'Customer', render: (r) => customerName(r.customerId) },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.status}
                color={getStatusBadgeColor('Load.status', r.status) ?? 'neutral'}
              />
            ),
          },
          {
            key: 'risk',
            header: 'Risk',
            render: (r) =>
              r.riskStatus !== 'NORMAL' ? (
                <Badge
                  label={r.riskStatus}
                  color={getStatusBadgeColor('Load.riskStatus', r.riskStatus) ?? 'warning'}
                />
              ) : null,
          },
          { key: 'carrier', header: 'Carrier', render: (r) => carrierName(r.assignedCarrierId) },
          {
            key: 'dispatcher',
            header: 'Dispatcher',
            render: (r) => dispatcherName(r.assignedDispatcherId),
          },
          {
            key: 'lane',
            header: 'Origin → Destination',
            render: (r) => originDestination(r.stops),
          },
          {
            key: 'pickupDate',
            header: 'Pickup',
            render: (r) => formatDateShort(firstPickupDate(r.stops)),
          },
          {
            key: 'deliveryDate',
            header: 'Delivery',
            render: (r) => formatDateShort(lastDeliveryDate(r.stops)),
          },
          {
            key: 'equipment',
            header: 'Equipment',
            render: (r) => r.equipmentType.replace('_', ' '),
          },
          {
            key: 'customerRate',
            header: 'Customer Rate',
            numeric: true,
            render: (r) => (r.customerRate != null ? `$${r.customerRate}` : '—'),
          },
          {
            key: 'carrierRate',
            header: 'Carrier Rate',
            numeric: true,
            render: (r) => (r.carrierRate != null ? `$${r.carrierRate}` : '—'),
          },
        ]}
      />
    </div>
  );
}
