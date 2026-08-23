import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { carriersApi, customersApi, membershipsApi, type Load } from '../../../api';
import { Badge } from '../../../components/ui';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import { usePermissions } from '../../../hooks/usePermissions';
import { formatDateShort, originDestination } from '../loadDerived';
import '../../shared/DetailPage.css';
import '../LoadDetailPage.css';

/**
 * UI_UX_DESIGN.md §5.4.4 Overview tab. Financial Summary card is fully
 * absent for Dispatcher (checked directly against `roles`, since
 * `viewLoadFinancials` alone would also hide it for Sales/Booking, who
 * the locked spec says *should* see a redacted version) — every value
 * inside the card still comes straight from the server's own
 * `shapeFinancialFields` redaction (null → "—"), so Margin naturally
 * never renders for Sales/Booking without any extra role logic (their
 * `carrierRate` is always server-redacted to null).
 */
export function OverviewTab({ load }: { load: Load }) {
  const { roles } = usePermissions();
  const showFinancialCard = !roles.includes('DISPATCHER');

  const { data: customer } = useQuery({
    queryKey: ['customers', load.customerId],
    queryFn: () => customersApi.getById(load.customerId),
  });
  const { data: carrier } = useQuery({
    queryKey: ['carriers', load.assignedCarrierId],
    queryFn: () => carriersApi.getById(load.assignedCarrierId!),
    enabled: Boolean(load.assignedCarrierId),
  });
  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
  });
  const dispatcher = memberships.find((m) => m.userId === load.assignedDispatcherId);

  const sortedStops = [...load.stops].sort((a, b) => a.sequence - b.sequence);

  const margin =
    load.customerRate != null && load.carrierRate != null
      ? Number(load.customerRate) - Number(load.carrierRate)
      : null;
  const marginPct =
    margin != null && Number(load.customerRate) !== 0
      ? (margin / Number(load.customerRate)) * 100
      : null;

  return (
    <div className="load-overview-grid">
      <div>
        <div className="detail-card">
          <h2 className="detail-card-title">Customer & Lane</h2>
          <div className="detail-card-grid">
            <Field
              label="Customer"
              value={
                customer ? <Link to={`/customers/${customer.id}`}>{customer.legalName}</Link> : '—'
              }
            />
            <Field label="Lane" value={originDestination(load.stops)} />
            <Field label="Equipment" value={load.equipmentType.replace('_', ' ')} />
            <Field label="Customer PO #" value={load.customerPoNumber || '—'} />
            <Field label="BOL #" value={load.bolNumber || '—'} />
            <Field label="Pickup #" value={load.pickupNumber || '—'} />
            <Field label="Reference #" value={load.customerReferenceNumber || '—'} />
          </div>
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Stops</h2>
          {sortedStops.map((stop) => (
            <div key={stop.id} className="load-stop-mini-row">
              <span>Stop {stop.sequence}</span>
              <Badge label={stop.stopType} color="neutral" />
              <span className="load-stop-mini-location">
                {stop.city}, {stop.state}
              </span>
              <span className="load-stop-mini-time">
                {formatDateShort(
                  stop.actualDeparture ?? stop.actualArrival ?? stop.appointmentDatetime ?? null,
                )}
              </span>
              <Badge
                label={stop.status}
                color={getStatusBadgeColor('Stop.status', stop.status) ?? 'neutral'}
              />
            </div>
          ))}
        </div>

        {load.riskStatus !== 'NORMAL' ? (
          <div className="detail-card" style={{ borderColor: 'var(--warning-600)' }}>
            <h2 className="detail-card-title">Risk: {load.riskStatus}</h2>
            <p style={{ margin: 0 }}>{load.riskReason || 'No reason provided.'}</p>
          </div>
        ) : null}
      </div>

      <div>
        <div className="detail-card">
          <h2 className="detail-card-title">Carrier & Dispatch</h2>
          {carrier ? (
            <div className="detail-card-grid">
              <Field
                label="Carrier"
                value={<Link to={`/carriers/${carrier.id}`}>{carrier.legalName}</Link>}
              />
              <Field label="Driver" value={load.dispatchRecord?.driverName || '—'} />
              <Field label="Truck" value={load.dispatchRecord?.truckNumber || '—'} />
              <Field label="Trailer" value={load.dispatchRecord?.trailerNumber || '—'} />
              <Field label="Dispatcher" value={dispatcher?.user.name || '—'} />
            </div>
          ) : (
            <span className="detail-field-value">Not yet assigned/dispatched.</span>
          )}
        </div>

        {showFinancialCard ? (
          <div className="detail-card">
            <h2 className="detail-card-title">Financial Summary</h2>
            <div className="detail-card-grid">
              <Field
                label="Customer Rate"
                value={load.customerRate != null ? `$${load.customerRate}` : '—'}
              />
              <Field
                label="Carrier Rate"
                value={load.carrierRate != null ? `$${load.carrierRate}` : '—'}
              />
              {margin != null ? (
                <Field label="Gross Profit" value={`$${margin.toFixed(2)}`} />
              ) : null}
              {marginPct != null ? (
                <Field label="Margin %" value={`${marginPct.toFixed(1)}%`} />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="detail-field-label">{label}</div>
      <div className="detail-field-value">{value}</div>
    </div>
  );
}
