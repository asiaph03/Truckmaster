import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportingApi } from '../../api';
import { EmptyState, QueryErrorState } from '../ui';
import { LeafletMap } from './LeafletMap';
import { buildFleetMapData } from './fleetMapData';
import { MapLegend } from './MapLegend';
import { MAP_COLORS } from './mapColors';
import './FleetMap.css';

/**
 * Dashboard Map Phase — "Truck Locations & Destinations". A truck only
 * ever becomes a map marker when its Load has a real, geocodable
 * `lastKnownLocation` (set by an actual logged Check Call) — a missing
 * location, or one this bundled dataset can't resolve, puts that truck
 * in the plain-text "Location unavailable" list instead of guessing a
 * position. Available (undispatched) trucks are never placed on the map
 * at all, since they have no location concept whatsoever — they render
 * as their own plain list, exactly as the brief specifies.
 */
export function FleetMap() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboard', 'fleet-map'],
    queryFn: () => reportingApi.fleetMap(),
  });

  const { markers, lines, unresolvedTrucks } = useMemo(
    () => buildFleetMapData(data?.activeTrucks ?? []),
    [data],
  );

  if (isLoading) {
    return <div className="fleet-map-loading">Loading fleet map…</div>;
  }

  if (isError) {
    return (
      <QueryErrorState
        message="Couldn't load Truck Locations & Destinations. Please try again."
        onRetry={() => refetch()}
      />
    );
  }

  const activeTrucks = data?.activeTrucks ?? [];
  const availableTrucks = data?.availableTrucks ?? [];

  return (
    <div className="fleet-map">
      <div className="fleet-map-header">
        <h2 className="fleet-map-title">Truck Locations &amp; Destinations</h2>
        <span className="fleet-map-subtitle">
          Each marker is a Truck / Driver — last known location, from the Load's most recent logged
          Check Call. Not live GPS, and not independent driver tracking.
        </span>
      </div>

      {activeTrucks.length === 0 ? (
        <EmptyState message="No trucks are currently dispatched." />
      ) : (
        <>
          <LeafletMap
            markers={markers}
            lines={lines}
            fitBoundsKey={activeTrucks.map((t) => t.loadId).join(',')}
            height={420}
          />
          <MapLegend
            items={[
              { color: MAP_COLORS.danger, label: 'Delayed' },
              { color: MAP_COLORS.warning, label: 'At risk' },
              { color: MAP_COLORS.info, label: 'In transit' },
              { color: MAP_COLORS.success, label: 'Delivered / closed' },
              { color: MAP_COLORS.brand, label: 'Dispatched / booked' },
            ]}
          />
        </>
      )}

      {unresolvedTrucks.length > 0 ? (
        <div className="fleet-map-unresolved">
          <h3 className="fleet-map-section-title">Location unavailable</h3>
          <ul>
            {unresolvedTrucks.map((t) => (
              <li key={t.loadId}>
                <b>{t.truckNumber}</b> — {t.driverName} — Load{' '}
                <a href={`/loads/${t.loadId}`}>{t.loadNumber}</a>
                {t.destinationLabel ? <> → {t.destinationLabel}</> : null}
                <span className="fleet-map-unresolved-reason">
                  {t.lastKnownLocation
                    ? ' (city not in map dataset yet)'
                    : ' (no Check Call logged yet)'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {availableTrucks.length > 0 ? (
        <div className="fleet-map-available">
          <h3 className="fleet-map-section-title">Available — no active load</h3>
          <ul>
            {availableTrucks.map((t) => (
              <li key={t.truckId}>
                <b>{t.unitNumber}</b> —{' '}
                <a href={`/carriers/${t.carrierId}`}>{t.carrierLegalName}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
