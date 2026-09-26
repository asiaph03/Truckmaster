import type { FleetMapActiveTruck } from '../../api';
import { destinationCityState } from '../../routes/loads/loadDerived';
import { formatRelativeTime } from '../../lib/formatRelativeTime';
import { escapeHtml } from '../../lib/escapeHtml';
import { geocodeCityState } from '../../lib/geocoding';
import { truckMarkerColor } from './mapColors';
import type { MapLineSpec, MapMarkerSpec } from './LeafletMap';

export interface UnresolvedTruck {
  loadId: string;
  loadNumber: string;
  truckNumber: string;
  driverName: string;
  lastKnownLocation: FleetMapActiveTruck['lastKnownLocation'];
  destinationLabel: string | null;
}

/**
 * Every truck marker represents the truck itself at its last-known
 * Check Call location — we have no independent driver GPS, so the
 * driver shown here is only "whoever this Load's DispatchRecord says
 * is assigned," never a tracked position of their own. A blank name
 * (no driver assigned) reads as "Unassigned" rather than a blank line.
 */
function resolveDriverLabel(driverName: string): string {
  return driverName.trim() || 'Unassigned';
}

/**
 * Pure, independently testable — turns the API response into map-ready
 * markers/lines plus the unresolved (unmappable) list. Kept in its own
 * (non-component) file so `FleetMap.tsx` only exports the component
 * itself, per Vite's fast-refresh boundary rule.
 */
export function buildFleetMapData(activeTrucks: FleetMapActiveTruck[]): {
  markers: MapMarkerSpec[];
  lines: MapLineSpec[];
  unresolvedTrucks: UnresolvedTruck[];
} {
  const markers: MapMarkerSpec[] = [];
  const lines: MapLineSpec[] = [];
  const unresolvedTrucks: UnresolvedTruck[] = [];

  for (const truck of activeTrucks) {
    const destination = destinationCityState(truck.stops);
    const destinationLabel = destination ? `${destination.city}, ${destination.state}` : null;
    const driverName = resolveDriverLabel(truck.driverName);

    if (!truck.lastKnownLocation) {
      unresolvedTrucks.push({
        loadId: truck.loadId,
        loadNumber: truck.loadNumber,
        truckNumber: truck.truckNumber,
        driverName,
        lastKnownLocation: null,
        destinationLabel,
      });
      continue;
    }

    const point = geocodeCityState(truck.lastKnownLocation.city, truck.lastKnownLocation.state);
    if (!point) {
      unresolvedTrucks.push({
        loadId: truck.loadId,
        loadNumber: truck.loadNumber,
        truckNumber: truck.truckNumber,
        driverName,
        lastKnownLocation: truck.lastKnownLocation,
        destinationLabel,
      });
      continue;
    }

    const color = truckMarkerColor(truck.loadStatus, truck.riskStatus);
    markers.push({
      id: truck.loadId,
      lat: point.lat,
      lng: point.lng,
      color,
      // Truck + assigned driver together — this is still one physical
      // vehicle's last-known location, never a second, independent
      // driver position.
      ariaLabel: `${escapeHtml(truck.truckNumber)} — ${escapeHtml(driverName)} — Load ${escapeHtml(truck.loadNumber)}`,
      popupHtml: buildTruckPopupHtml(truck, driverName, destinationLabel),
    });

    if (destination) {
      const destinationPoint = geocodeCityState(destination.city, destination.state);
      if (destinationPoint) {
        lines.push({
          id: truck.loadId,
          points: [
            [point.lat, point.lng],
            [destinationPoint.lat, destinationPoint.lng],
          ],
          color,
        });
      }
    }
  }

  return { markers, lines, unresolvedTrucks };
}

function buildTruckPopupHtml(
  truck: FleetMapActiveTruck,
  driverName: string,
  destinationLabel: string | null,
): string {
  const loc = truck.lastKnownLocation;
  const locationText = loc
    ? `${escapeHtml(loc.city)}, ${escapeHtml(loc.state)} — ${escapeHtml(formatRelativeTime(loc.updatedAt))}`
    : 'Unavailable';

  const rows = [
    ['Truck', escapeHtml(truck.truckNumber)],
    ['Driver', escapeHtml(driverName)],
    ['Load', escapeHtml(truck.loadNumber)],
    ['Last Known Location', locationText],
    ['Destination', destinationLabel ? escapeHtml(destinationLabel) : '—'],
    ['Status', escapeHtml(truck.loadStatus.replace('_', ' '))],
    [
      'ETA',
      truck.currentEta ? escapeHtml(new Date(truck.currentEta).toLocaleString()) : 'Unavailable',
    ],
  ]
    .map(
      ([label, value]) =>
        `<div class="map-popup-row"><span class="map-popup-label">${label}</span><span>${value}</span></div>`,
    )
    .join('');

  const carrierLink = truck.assignedCarrierId
    ? `<a href="/carriers/${escapeHtml(truck.assignedCarrierId)}">View Carrier</a>`
    : '';

  return (
    // Truck + driver together in the title — the marker is one truck's
    // last-known location; the driver name is surfaced prominently here
    // (not as a separate marker/position) since that's the person
    // physically at this location right now.
    `<div class="map-popup-title">${escapeHtml(truck.truckNumber)}</div>` +
    `<div class="map-popup-subtitle">${escapeHtml(driverName)}</div>` +
    rows +
    `<div class="map-popup-actions"><a href="/loads/${escapeHtml(truck.loadId)}">View Load</a>${carrierLink}</div>`
  );
}
