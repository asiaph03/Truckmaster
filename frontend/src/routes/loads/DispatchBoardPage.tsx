import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { EQUIPMENT_TYPES } from '@tms/shared-constants';
import {
  carriersApi,
  customersApi,
  loadsApi,
  membershipsApi,
  type EligibilityErrorDetails,
  type LoadSearchFilters,
  type LoadSummary,
} from '../../api';
import { ApiError } from '../../api/errors';
import {
  Badge,
  BulkActionBar,
  Button,
  CurrencyInput,
  DataTable,
  Drawer,
  FilterChip,
  Modal,
  ModalFooter,
  RowActionsMenu,
  SearchableCombobox,
  Select,
  Toggle,
} from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import {
  firstPickupDate,
  formatDateShort,
  isWithinHours,
  lastDeliveryDate,
  originDestination,
} from './loadDerived';
import { KanbanBoard } from './KanbanBoard';
import { CalendarBoard } from './CalendarBoard';
import { NewLoadChoiceModal } from './modals/NewLoadChoiceModal';
import { AssignDispatcherModal } from './modals/AssignDispatcherModal';
import '../shared/ListPage.css';
import './DispatchBoardPage.css';

type BoardView = 'table' | 'kanban' | 'calendar';

const EQUIPMENT_OPTIONS = EQUIPMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));
const STATUS_OPTIONS = [
  { value: '', label: 'All (excl. Closed)' },
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

type QuickFilter = 'pickups4h' | 'deliveries4h' | 'today' | 'overdue' | null;

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * No locked "new-org empty state" exists (§5.3.13, left open in the
 * spec itself) — uses the standard `EmptyState` pattern. Row-click
 * Drawer intentionally shows a summary + "Open Full Detail" only (no
 * duplicated context-sensitive action button) — Load Detail is the
 * authoritative place for lifecycle actions, keeping the state-machine
 * logic in one place.
 *
 * Frontend Phase 18 — bulk Assign Carrier and page/selection Export
 * (§5.4.1's full bulk action bar: "Assign Dispatcher", "Assign Carrier",
 * "Export Selected", plus a page-level filtered `Export`). Page-level
 * Export is Table-View-only (matches this phase's approved scope; Kanban
 * has no selection/bulk-bar UI at all). It's disabled while the "Today"
 * or "Overdue" quick filter is active — both compose an OR across
 * pickup/delivery-date ranges plus a status exclusion that
 * `/loads/search/export`'s filter shape cannot faithfully express today
 * (AND-only between pickup/delivery ranges, no "status not in" support
 * beyond the one added `excludeClosed` flag) — rather than silently
 * exporting a superset of what's on screen.
 */
export function DispatchBoardPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();

  // UI_UX_DESIGN.md §5.1.4 sitemap — Table/Kanban/Calendar are one screen
  // at `/loads/board?view=`, not separate URL-level identities.
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get('view');
  const view: BoardView =
    viewParam === 'kanban' ? 'kanban' : viewParam === 'calendar' ? 'calendar' : 'table';
  function setView(next: BoardView) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'table') params.delete('view');
        else params.set('view', next);
        return params;
      },
      { replace: true },
    );
  }

  const [status, setStatus] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [carrierId, setCarrierId] = useState('');
  const [dispatcherId, setDispatcherId] = useState('');
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerLoad, setDrawerLoad] = useState<LoadSummary | null>(null);
  const [newLoadModalOpen, setNewLoadModalOpen] = useState(false);
  const [assigningDispatcherFor, setAssigningDispatcherFor] = useState<string | null>(null);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkAssigningCarrier, setBulkAssigningCarrier] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingSelected, setExportingSelected] = useState(false);

  const canManage = can('sourceAndDispatchLoads');

  // Frontend Phase 18 — "Today"/"Overdue" compose an OR across
  // pickup-range and delivery-range plus a status exclusion that the
  // export endpoint's filter shape can't faithfully express (see the
  // component doc comment above) — Export is disabled rather than
  // silently exporting a superset of what's on screen.
  const exportUnavailableReason =
    quickFilter === 'today' || quickFilter === 'overdue'
      ? `Export isn't available while "${quickFilter === 'today' ? 'Today' : 'Overdue'}" is active — clear the quick filter to export.`
      : null;

  /** Maps Table View's current filters onto /loads/search/export's params, per Decision #3. */
  function buildPageExportFilters(): LoadSearchFilters {
    const filters: LoadSearchFilters = {
      equipmentType: equipmentType || undefined,
      carrierId: carrierId || undefined,
      dispatcherId: dispatcherId || undefined,
      q: search.trim() || undefined,
    };
    if (status) {
      filters.status = status;
    } else {
      filters.excludeClosed = true;
    }
    if (quickFilter === 'pickups4h' || quickFilter === 'deliveries4h') {
      const now = new Date();
      const in4h = new Date(now.getTime() + 4 * 60 * 60 * 1000);
      if (quickFilter === 'pickups4h') {
        filters.pickupFrom = now.toISOString();
        filters.pickupTo = in4h.toISOString();
      } else {
        filters.deliveryFrom = now.toISOString();
        filters.deliveryTo = in4h.toISOString();
      }
    }
    return filters;
  }

  async function handleExportPage() {
    setExporting(true);
    try {
      await loadsApi.exportSearchCsv(buildPageExportFilters());
    } catch {
      toast.danger('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  async function handleExportSelected() {
    setExportingSelected(true);
    try {
      await loadsApi.exportSearchCsv({ ids: Array.from(selected) });
    } catch {
      toast.danger('Export failed. Please try again.');
    } finally {
      setExportingSelected(false);
    }
  }

  // Kanban shows every status as its own column (§5.4.2) and Calendar
  // organizes by date, not status (§5.4.3) — the Status dropdown is
  // Table-only, so the server-side status filter never applies to those
  // two views, regardless of what it was last set to.
  const { data: loads = [], isLoading } = useQuery({
    queryKey: [
      'loads',
      { status: view === 'table' ? status : '', equipmentType, carrierId, dispatcherId },
    ],
    queryFn: () =>
      loadsApi.list({
        status: view === 'table' ? status || undefined : undefined,
        equipmentType: equipmentType || undefined,
        carrierId: carrierId || undefined,
        dispatcherId: dispatcherId || undefined,
      }),
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
  // One consistent resolver reused by Table, Kanban, Calendar, and search
  // alike — `assignedDriverName` is already fully resolved server-side
  // (LoadService.list: live sourceDriver name when linked, else the
  // DispatchRecord's own snapshotted name for a manually-typed dispatch),
  // this just supplies the display fallback for "never dispatched".
  const driverName = (l: LoadSummary) => l.assignedDriverName ?? 'Unassigned';
  // Shared by every view's search filter below — Load #, Customer, and
  // Driver (full name, first name, last name, or any partial substring,
  // since it's a plain case-insensitive substring match against the
  // already-resolved full name). A Load with no assigned driver simply
  // never matches on the driver clause — the loadNumber/customer clauses
  // still work normally for it.
  const matchesSearch = (l: LoadSummary, q: string) =>
    l.loadNumber.toLowerCase().includes(q) ||
    customerName(l.customerId).toLowerCase().includes(q) ||
    (l.assignedDriverName ?? '').toLowerCase().includes(q);

  const filtered = useMemo(() => {
    let rows = loads;
    if (!status) rows = rows.filter((l) => l.status !== 'CLOSED');
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((l) => matchesSearch(l, q));
    }
    if (quickFilter === 'pickups4h')
      rows = rows.filter((l) => isWithinHours(firstPickupDate(l.stops), 4));
    if (quickFilter === 'deliveries4h')
      rows = rows.filter((l) => isWithinHours(lastDeliveryDate(l.stops), 4));
    if (quickFilter === 'today')
      rows = rows.filter(
        (l) => isToday(firstPickupDate(l.stops)) || isToday(lastDeliveryDate(l.stops)),
      );
    if (quickFilter === 'overdue')
      rows = rows.filter((l) => {
        const pickup = firstPickupDate(l.stops);
        const delivery = lastDeliveryDate(l.stops);
        const now = Date.now();
        return (
          (pickup &&
            new Date(pickup).getTime() < now &&
            l.status !== 'DELIVERED' &&
            l.status !== 'CLOSED') ||
          (delivery &&
            new Date(delivery).getTime() < now &&
            l.status !== 'DELIVERED' &&
            l.status !== 'CLOSED')
        );
      });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, status, search, quickFilter, customers]);

  // Kanban's own "Show Closed" toggle replaces Table View's status-driven
  // exclusion, and Kanban has no quick-filter chips — just the shared
  // text search applies before KanbanBoard buckets rows into columns.
  const kanbanFiltered = useMemo(() => {
    if (!search.trim()) return loads;
    const q = search.trim().toLowerCase();
    return loads.filter((l) => matchesSearch(l, q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, search, customers]);

  // Calendar has no "Show Closed" toggle of its own (§5.4.3 lists no such
  // control) — Closed loads stay reachable via Load Search's "all loads
  // including closed" escape hatch (Frontend Phase 13), matching Table
  // View's own default-excludes-Closed behavior rather than inventing a
  // new toggle.
  const calendarFiltered = useMemo(() => {
    const notClosed = loads.filter((l) => l.status !== 'CLOSED');
    if (!search.trim()) return notClosed;
    const q = search.trim().toLowerCase();
    return notClosed.filter((l) => matchesSearch(l, q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, search, customers]);

  function afterMutation() {
    queryClient.invalidateQueries({ queryKey: ['loads'] });
  }

  return (
    <div>
      <div className="list-page-header">
        <div>
          <h1 className="list-page-title">Dispatch Board</h1>
          <div className="dispatch-board-view-switch">
            <button
              type="button"
              className={view === 'table' ? 'active' : ''}
              onClick={() => setView('table')}
            >
              Table
            </button>
            <button
              type="button"
              className={view === 'kanban' ? 'active' : ''}
              onClick={() => setView('kanban')}
            >
              Kanban
            </button>
            <button
              type="button"
              className={view === 'calendar' ? 'active' : ''}
              onClick={() => setView('calendar')}
            >
              Calendar
            </button>
          </div>
        </div>
        <div className="dispatch-board-header-actions">
          <Button variant="secondary" onClick={() => navigate('/loads/search')}>
            Load Search
          </Button>
          {view === 'table' ? (
            <Button
              variant="secondary"
              onClick={handleExportPage}
              disabled={exporting || exportUnavailableReason !== null}
              title={exportUnavailableReason ?? undefined}
            >
              {exporting ? 'Exporting…' : 'Export'}
            </Button>
          ) : null}
          {can('createQuoteOrLoad') ? (
            <Button onClick={() => setNewLoadModalOpen(true)}>+ New Load</Button>
          ) : null}
        </div>
      </div>
      {view === 'table' && exportUnavailableReason ? (
        <p className="dispatch-board-export-note">{exportUnavailableReason}</p>
      ) : null}

      <div className="list-page-toolbar">
        <div className="list-page-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            placeholder="Search Load #, Customer, or Driver…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {view === 'table' ? (
          <select
            className="field-select list-page-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : null}
        <select
          className="field-select list-page-filter"
          value={equipmentType}
          onChange={(e) => setEquipmentType(e.target.value)}
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
          value={carrierId}
          onChange={(e) => setCarrierId(e.target.value)}
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
          onChange={(e) => setDispatcherId(e.target.value)}
        >
          <option value="">All dispatchers</option>
          {memberships.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.user.name}
            </option>
          ))}
        </select>
        {view === 'kanban' ? (
          <Toggle
            label="Show Closed"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
        ) : null}
      </div>

      {view === 'table' && selected.size > 0 ? (
        <BulkActionBar selectedCount={selected.size} onClear={() => setSelected(new Set())}>
          {canManage ? (
            <Button size="sm" variant="secondary" onClick={() => setBulkAssigning(true)}>
              Assign Dispatcher
            </Button>
          ) : null}
          {canManage ? (
            <Button size="sm" variant="secondary" onClick={() => setBulkAssigningCarrier(true)}>
              Assign Carrier
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={handleExportSelected}
            disabled={exportingSelected}
          >
            {exportingSelected ? 'Exporting…' : 'Export Selected'}
          </Button>
        </BulkActionBar>
      ) : view === 'table' ? (
        <div className="dispatch-board-chips">
          <FilterChip
            label="Pickups next 4h"
            active={quickFilter === 'pickups4h'}
            onClick={() => setQuickFilter(quickFilter === 'pickups4h' ? null : 'pickups4h')}
          />
          <FilterChip
            label="Deliveries next 4h"
            active={quickFilter === 'deliveries4h'}
            onClick={() => setQuickFilter(quickFilter === 'deliveries4h' ? null : 'deliveries4h')}
          />
          <FilterChip
            label="Today"
            active={quickFilter === 'today'}
            onClick={() => setQuickFilter(quickFilter === 'today' ? null : 'today')}
          />
          <FilterChip
            label="Overdue"
            active={quickFilter === 'overdue'}
            onClick={() => setQuickFilter(quickFilter === 'overdue' ? null : 'overdue')}
          />
        </div>
      ) : null}

      {view === 'kanban' ? (
        <KanbanBoard
          loads={kanbanFiltered}
          canManage={canManage}
          showClosed={showClosed}
          customerName={customerName}
          carrierName={carrierName}
          dispatcherInitial={dispatcherName}
          onCardClick={(load) => setDrawerLoad(load)}
          onChanged={afterMutation}
        />
      ) : null}

      {view === 'calendar' ? (
        <CalendarBoard
          loads={calendarFiltered}
          canManage={canManage}
          onCardClick={(load) => setDrawerLoad(load)}
          onChanged={afterMutation}
        />
      ) : null}

      {view === 'table' ? (
        <DataTable
          loading={isLoading}
          rows={filtered}
          rowKey={(r) => r.id}
          selectable
          selectedKeys={selected}
          onSelectionChange={setSelected}
          onRowClick={(row) => setDrawerLoad(row)}
          emptyMessage="No loads match your filters."
          columns={[
            { key: 'loadNumber', header: 'Load #', render: (r) => r.loadNumber },
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
            { key: 'driver', header: 'Driver', render: (r) => driverName(r) },
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
              key: 'pickup',
              header: 'Pickup',
              render: (r) => formatDateShort(firstPickupDate(r.stops)),
            },
            {
              key: 'delivery',
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
          rowActions={
            canManage
              ? (r) => (
                  <RowActionsMenu>
                    <button
                      className="data-table-row-action"
                      onClick={() => navigate(`/loads/${r.id}`)}
                    >
                      Open Full Detail
                    </button>
                    <button
                      className="data-table-row-action"
                      onClick={() => setAssigningDispatcherFor(r.id)}
                    >
                      {r.assignedDispatcherId ? 'Reassign Dispatcher' : 'Assign Dispatcher'}
                    </button>
                  </RowActionsMenu>
                )
              : undefined
          }
        />
      ) : null}

      <NewLoadChoiceModal open={newLoadModalOpen} onClose={() => setNewLoadModalOpen(false)} />

      <Drawer
        open={drawerLoad !== null}
        title={drawerLoad?.loadNumber ?? ''}
        onClose={() => setDrawerLoad(null)}
      >
        {drawerLoad ? (
          <div>
            <p>
              <strong>Customer:</strong> {customerName(drawerLoad.customerId)}
            </p>
            <p>
              <strong>Status:</strong>{' '}
              <Badge
                label={drawerLoad.status}
                color={getStatusBadgeColor('Load.status', drawerLoad.status) ?? 'neutral'}
              />
            </p>
            <p>
              <strong>Carrier:</strong> {carrierName(drawerLoad.assignedCarrierId)}
            </p>
            <p>
              <strong>Lane:</strong> {originDestination(drawerLoad.stops)}
            </p>
            <Button onClick={() => navigate(`/loads/${drawerLoad.id}`)}>Open Full Detail →</Button>
          </div>
        ) : null}
      </Drawer>

      {assigningDispatcherFor ? (
        <AssignDispatcherModal
          open
          loadId={assigningDispatcherFor}
          onClose={() => setAssigningDispatcherFor(null)}
          onAssigned={() => {
            setAssigningDispatcherFor(null);
            afterMutation();
          }}
        />
      ) : null}

      {bulkAssigning ? (
        <BulkAssignDispatcherFlow
          loadIds={Array.from(selected)}
          onClose={() => setBulkAssigning(false)}
          onDone={() => {
            setBulkAssigning(false);
            setSelected(new Set());
            afterMutation();
          }}
        />
      ) : null}

      {bulkAssigningCarrier ? (
        <BulkAssignCarrierFlow
          loadIds={Array.from(selected)}
          resolveLoadNumber={(id) => loads.find((l) => l.id === id)?.loadNumber ?? id}
          onAssigned={afterMutation}
          onClose={() => {
            setBulkAssigningCarrier(false);
            setSelected(new Set());
          }}
        />
      ) : null}
    </div>
  );
}

/** Applies one dispatcher choice to every selected Load, sequentially (no bulk endpoint exists — nor is one needed at this scale). */
function BulkAssignDispatcherFlow({
  loadIds,
  onClose,
  onDone,
}: {
  loadIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
  });
  const [dispatcherUserId, setDispatcherUserId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function apply() {
    if (!dispatcherUserId) return;
    setSubmitting(true);
    try {
      await Promise.all(loadIds.map((id) => loadsApi.setDispatcher(id, { dispatcherUserId })));
      toast.success(`Dispatcher assigned to ${loadIds.length} load(s).`);
      onDone();
    } catch {
      toast.danger('Some loads could not be updated.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      title={`Assign Dispatcher to ${loadIds.length} Load(s)`}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={apply}
          confirmLabel="Assign"
          loading={submitting}
        />
      }
    >
      <Select
        label="Dispatcher"
        required
        value={dispatcherUserId}
        onChange={(e) => setDispatcherUserId(e.target.value)}
        options={memberships.map((m) => ({ value: m.userId, label: m.user.name }))}
      />
    </Modal>
  );
}

interface BulkCarrierAssignResult {
  loadId: string;
  status: 'success' | 'error';
  message?: string;
}

function extractAssignCarrierError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'ELIGIBILITY_ERROR') {
    const reasons = (error.details as EligibilityErrorDetails | undefined)?.reasons ?? [];
    return reasons.length > 0 ? reasons.join('; ') : error.message;
  }
  return error instanceof ApiError ? error.message : 'Something went wrong.';
}

/**
 * Applies one Carrier + one Carrier Rate to every selected Load — same
 * shared-value shape as BulkAssignDispatcherFlow, and same "no bulk
 * backend endpoint, loop the existing single-load call" approach
 * (Frontend Phase 18 decision). Unlike the dispatcher flow, this uses
 * `Promise.allSettled` and shows a per-load result: Carrier assignment
 * is gated by a real per-load eligibility check (unlike dispatcher
 * assignment, which essentially never fails), so collapsing a mixed
 * outcome into one generic toast would hide real, actionable
 * information — the locked spec's own "each selected Load is still
 * individually validated... at confirmation" is exactly what this
 * surfaces, reusing AssignCarrierModal's existing eligibility-reason
 * extraction per load instead of inventing new business logic.
 */
function BulkAssignCarrierFlow({
  loadIds,
  resolveLoadNumber,
  onClose,
  onAssigned,
}: {
  loadIds: string[];
  resolveLoadNumber: (id: string) => string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const { data: carriers = [] } = useQuery({
    queryKey: ['carriers', {}],
    queryFn: () => carriersApi.list(),
  });
  const [carrierId, setCarrierId] = useState('');
  const [carrierRate, setCarrierRate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BulkCarrierAssignResult[] | null>(null);
  const toast = useToast();

  async function apply() {
    if (!carrierId || !carrierRate) return;
    setSubmitting(true);
    try {
      const settled = await Promise.allSettled(
        loadIds.map((id) => loadsApi.assignCarrier(id, { carrierId, carrierRate })),
      );
      const nextResults: BulkCarrierAssignResult[] = settled.map((outcome, i) => ({
        loadId: loadIds[i],
        status: outcome.status === 'fulfilled' ? 'success' : 'error',
        message:
          outcome.status === 'rejected' ? extractAssignCarrierError(outcome.reason) : undefined,
      }));
      setResults(nextResults);
      const successCount = nextResults.filter((r) => r.status === 'success').length;
      if (successCount === loadIds.length) {
        toast.success(`Carrier assigned to ${successCount} load(s).`);
      } else if (successCount > 0) {
        toast.danger(
          `Carrier assigned to ${successCount} of ${loadIds.length} load(s) — see details.`,
        );
      } else {
        toast.danger('No loads could be assigned — see details.');
      }
      onAssigned();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      title={results ? `Assign Carrier — Results` : `Assign Carrier to ${loadIds.length} Load(s)`}
      onClose={onClose}
      footer={
        results ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <ModalFooter
            onCancel={onClose}
            onConfirm={apply}
            confirmLabel="Assign"
            loading={submitting}
          />
        )
      }
    >
      {results ? (
        <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
          {results.map((r) => (
            <li key={r.loadId}>
              {resolveLoadNumber(r.loadId)} —{' '}
              {r.status === 'success' ? (
                <span style={{ color: 'var(--success-700)' }}>Assigned</span>
              ) : (
                <span style={{ color: 'var(--danger-700)' }}>Failed: {r.message}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <SearchableCombobox
            label="Carrier"
            required
            value={carrierId || null}
            onChange={(value) => setCarrierId(value ?? '')}
            options={carriers.map((c) => ({
              value: c.id,
              label: `${c.legalName} (${c.assignmentEligible ? 'Eligible' : 'Ineligible'})`,
            }))}
          />
          <CurrencyInput
            label="Carrier Rate"
            required
            value={carrierRate}
            onChange={(e) => setCarrierRate(e.target.value)}
          />
        </>
      )}
    </Modal>
  );
}
