import { useMemo, useState } from 'react';
import type { Stop } from '../../api';
import { formatRelativeTime } from '../../lib/formatRelativeTime';
import { escapeHtml } from '../../lib/escapeHtml';
import { geocodeCityState } from '../../lib/geocoding';
import { stopMarkerColor, MAP_COLORS } from './mapColors';
import { LeafletMap, type MapLineSpec, type MapMarkerSpec } from './LeafletMap';
import { MapLegend } from './MapLegend';
import { Button, EmptyState } from '../ui';
import './LoadRouteMap.css';

export interface LoadRouteMapTruckLocation {
  truckNumber: string;
  city: string;
  state: string;
  description: string | null;
  updatedAt: string;
}

export interface LoadRouteMapProps {
  stops: Stop[];
  /** Only passed when the Load has both a DispatchRecord and a logged Check Call — `null` renders "Truck location unavailable", never a guessed position. */
  truckLocation?: LoadRouteMapTruckLocation | null;
  selectedStopId?: string | null;
  onSelectStop?: (stopId: string) => void;
}

const TRUCK_MARKER_ID = '__truck__';

/**
 * Load Overview's per-load route map. Reuses the exact `stops` array
 * `OverviewTab` already fetches and sorts — no second data source. Each
 * stop that can be geocoded (its city/state resolve in the bundled
 * dataset) becomes a marker colored Completed/Current/Upcoming per its
 * own `Stop.status`; a stop that can't be geocoded is listed as text
 * only, never dropped silently and never placed at a guessed point.
 */
export function LoadRouteMap({
  stops,
  truckLocation,
  selectedStopId,
  onSelectStop,
}: LoadRouteMapProps) {
  const [fitTick, setFitTick] = useState(0);

  const sorted = useMemo(() => [...stops].sort((a, b) => a.sequence - b.sequence), [stops]);

  const { markers, lines, unresolvedStops } = useMemo(() => {
    const resolved: { stop: Stop; lat: number; lng: number }[] = [];
    const unresolved: Stop[] = [];

    for (const stop of sorted) {
      const point = geocodeCityState(stop.city, stop.state);
      if (point) resolved.push({ stop, ...point });
      else unresolved.push(stop);
    }

    const stopMarkers: MapMarkerSpec[] = resolved.map(({ stop, lat, lng }) => ({
      id: stop.id,
      lat,
      lng,
      color: stopMarkerColor(stopState(stop)),
      ariaLabel: `Stop ${stop.sequence}: ${stop.city}, ${stop.state}`,
      popupHtml: buildStopPopupHtml(stop),
    }));

    const routeLines: MapLineSpec[] =
      resolved.length > 1
        ? [
            {
              id: 'route',
              points: resolved.map((r) => [r.lat, r.lng] as [number, number]),
              color: MAP_COLORS.neutral,
            },
          ]
        : [];

    let truckMarker: MapMarkerSpec | null = null;
    if (truckLocation) {
      const point = geocodeCityState(truckLocation.city, truckLocation.state);
      if (point) {
        truckMarker = {
          id: TRUCK_MARKER_ID,
          lat: point.lat,
          lng: point.lng,
          color: MAP_COLORS.brand,
          ariaLabel: `${truckLocation.truckNumber} — last known location`,
          popupHtml: buildTruckLocationPopupHtml(truckLocation),
        };
      }
    }

    return {
      markers: truckMarker ? [...stopMarkers, truckMarker] : stopMarkers,
      lines: routeLines,
      unresolvedStops: unresolved,
    };
  }, [sorted, truckLocation]);

  if (markers.length === 0) {
    return <EmptyState message="No stop locations could be placed on a map yet." />;
  }

  return (
    <div className="load-route-map">
      <LeafletMap
        markers={markers}
        lines={lines}
        selectedId={selectedStopId}
        onMarkerClick={(id) => {
          if (id !== TRUCK_MARKER_ID) onSelectStop?.(id);
        }}
        fitBoundsKey={`${sorted.map((s) => s.id).join(',')}-${truckLocation?.city ?? ''}-${fitTick}`}
        height={360}
      />
      <MapLegend
        items={[
          { color: MAP_COLORS.success, label: 'Completed stop' },
          { color: MAP_COLORS.info, label: 'Current stop' },
          { color: MAP_COLORS.neutral, label: 'Upcoming stop' },
          { color: MAP_COLORS.brand, label: 'Truck — last known location' },
        ]}
      />
      <div className="load-route-map-footer">
        {truckLocation ? (
          <div className="load-route-map-truck">
            <b>{truckLocation.truckNumber}</b> Last Known Location: {truckLocation.city},{' '}
            {truckLocation.state} — {formatRelativeTime(truckLocation.updatedAt)}
          </div>
        ) : (
          <div className="load-route-map-truck load-route-map-truck-unavailable">
            Truck location unavailable
          </div>
        )}
        <Button variant="tertiary" size="sm" onClick={() => setFitTick((t) => t + 1)}>
          Fit to Route
        </Button>
      </div>
      {unresolvedStops.length > 0 ? (
        <p className="load-route-map-unresolved">
          {unresolvedStops.length} stop{unresolvedStops.length === 1 ? '' : 's'} not shown on the
          map (city not in the map dataset yet):{' '}
          {unresolvedStops.map((s) => `${s.city}, ${s.state}`).join('; ')}
        </p>
      ) : null}
    </div>
  );
}

function stopState(stop: Stop): 'completed' | 'current' | 'upcoming' {
  if (stop.status === 'COMPLETED') return 'completed';
  if (stop.status === 'ARRIVED') return 'current';
  return 'upcoming';
}

function buildStopPopupHtml(stop: Stop): string {
  return (
    `<div class="map-popup-title">Stop ${stop.sequence}: ${escapeHtml(stop.stopType)}</div>` +
    `<div class="map-popup-row"><span class="map-popup-label">Location</span><span>${escapeHtml(stop.city)}, ${escapeHtml(stop.state)}</span></div>` +
    `<div class="map-popup-row"><span class="map-popup-label">Status</span><span>${escapeHtml(stop.status)}</span></div>` +
    (stop.companyName
      ? `<div class="map-popup-row"><span class="map-popup-label">Company</span><span>${escapeHtml(stop.companyName)}</span></div>`
      : '')
  );
}

function buildTruckLocationPopupHtml(truck: LoadRouteMapTruckLocation): string {
  return (
    `<div class="map-popup-title">${escapeHtml(truck.truckNumber)}</div>` +
    `<div class="map-popup-row"><span class="map-popup-label">Last Known Location</span><span>${escapeHtml(truck.city)}, ${escapeHtml(truck.state)}</span></div>` +
    `<div class="map-popup-row"><span class="map-popup-label">Updated</span><span>${escapeHtml(formatRelativeTime(truck.updatedAt))}</span></div>`
  );
}
