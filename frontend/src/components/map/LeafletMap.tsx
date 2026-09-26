import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MAP_COLORS } from './mapColors';
import './LeafletMap.css';

/**
 * Dashboard Map Phase — the one shared, real Leaflet map used by both
 * `FleetMap` (Dashboard) and `LoadRouteMap` (Load Overview). Deliberately
 * built on `leaflet` directly rather than `react-leaflet`: `leaflet`
 * itself has no React peer dependency at all (a vanilla JS library), so
 * this avoids any React-19 compatibility question entirely, and matches
 * this codebase's existing lean-dependency style (see `package.json`).
 *
 * Tile source: OpenStreetMap's standard public tile server. This is the
 * documented, deliberate choice for local development and this
 * product's current internal scale (see the approved Dashboard Map
 * audit's §8) — OSM's own tile-usage policy discourages this for heavy
 * production traffic; a compliant paid provider (e.g. Stadia Maps,
 * MapTiler) is the recommended next step if usage ever grows enough to
 * matter, and would only require changing `TILE_URL_TEMPLATE` below —
 * never a component redesign.
 *
 * Markers are drawn as `L.circleMarker` (a vector layer styled entirely
 * by CSS-like properties) rather than the default pin icon, so marker
 * color can be driven directly by this product's existing status-color
 * tokens with no new icon assets to bundle.
 */
const TILE_URL_TEMPLATE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Contiguous US + a comfortable margin — the default view before any
// fit-to-markers runs, and the floor `fitBounds` never zooms in past.
const US_BOUNDS: L.LatLngBoundsExpression = [
  [24.0, -125.5],
  [49.5, -66.5],
];

export interface MapMarkerSpec {
  id: string;
  lat: number;
  lng: number;
  color: string;
  /** Plain HTML string — see this file's header comment on why popups use plain `<a href>` navigation rather than a mounted React tree. */
  popupHtml?: string;
  ariaLabel?: string;
}

export interface MapLineSpec {
  id: string;
  points: [number, number][];
  color: string;
  dashed?: boolean;
}

export interface LeafletMapProps {
  markers: MapMarkerSpec[];
  lines?: MapLineSpec[];
  selectedId?: string | null;
  onMarkerClick?: (id: string) => void;
  height?: number | string;
  /** Change this value to force the map to re-fit to the current markers (e.g. after a data reload with a different set of loads). */
  fitBoundsKey?: string;
}

const DEFAULT_RADIUS = 8;
const SELECTED_RADIUS = 12;
const GROUP_RING_RADIUS = SELECTED_RADIUS + 5;

/**
 * Two markers can legitimately share the exact same lat/lng (e.g. a
 * truck's last-known-location and a stop that both resolve to the same
 * city centroid) — real data, not a bug. Left alone, the later marker
 * simply covers the earlier one and swallows its clicks. Grouping by
 * coordinate lets every marker in a group stay independently selectable
 * via a small picker popup, instead of silently favoring whichever was
 * drawn last.
 */
function groupByCoordinate(markers: MapMarkerSpec[]): Map<string, MapMarkerSpec[]> {
  const groups = new Map<string, MapMarkerSpec[]>();
  for (const marker of markers) {
    const key = `${marker.lat},${marker.lng}`;
    const group = groups.get(key);
    if (group) group.push(marker);
    else groups.set(key, [marker]);
  }
  return groups;
}

function openGroupPicker(
  map: L.Map,
  lat: number,
  lng: number,
  group: MapMarkerSpec[],
  onMarkerClick: ((id: string) => void) | undefined,
) {
  const container = document.createElement('div');
  container.className = 'map-popup-multi';

  const title = document.createElement('div');
  title.className = 'map-popup-title';
  title.textContent = `${group.length} markers at this location`;
  container.appendChild(title);

  for (const marker of group) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'map-popup-multi-item';
    item.textContent = marker.ariaLabel ?? marker.id;
    item.addEventListener('click', () => {
      onMarkerClick?.(marker.id);
      if (marker.popupHtml) {
        L.popup().setLatLng([lat, lng]).setContent(marker.popupHtml).openOn(map);
      } else {
        map.closePopup();
      }
    });
    container.appendChild(item);
  }

  L.popup().setLatLng([lat, lng]).setContent(container).openOn(map);
}

export function LeafletMap({
  markers,
  lines = [],
  selectedId,
  onMarkerClick,
  height = 420,
  fitBoundsKey,
}: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const lineLayerRef = useRef<L.LayerGroup | null>(null);
  const circleMarkersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;

  // Map init — once per mount.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      scrollWheelZoom: true,
    }).fitBounds(US_BOUNDS);

    L.tileLayer(TILE_URL_TEMPLATE, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 18,
    }).addTo(map);

    markerLayerRef.current = L.layerGroup().addTo(map);
    lineLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Markers + lines — redrawn whenever the data changes.
  useEffect(() => {
    const map = mapRef.current;
    const markerLayer = markerLayerRef.current;
    const lineLayer = lineLayerRef.current;
    if (!map || !markerLayer || !lineLayer) return;

    markerLayer.clearLayers();
    lineLayer.clearLayers();
    circleMarkersRef.current.clear();

    for (const line of lines) {
      L.polyline(line.points, {
        color: line.color,
        weight: 2,
        dashArray: line.dashed === false ? undefined : '6 8',
        opacity: 0.7,
      }).addTo(lineLayer);
    }

    const groups = groupByCoordinate(markers);

    for (const marker of markers) {
      const isSelected = marker.id === selectedId;
      const group = groups.get(`${marker.lat},${marker.lng}`) ?? [marker];
      const isGrouped = group.length > 1;

      const circle = L.circleMarker([marker.lat, marker.lng], {
        radius: isSelected ? SELECTED_RADIUS : DEFAULT_RADIUS,
        color: '#ffffff',
        weight: 2,
        fillColor: marker.color,
        fillOpacity: 1,
      });

      // Leaflet has no first-class ARIA support for vector layers; this
      // tooltip is the pragmatic minimum so a screen reader / hover
      // announces something meaningful for the marker's own DOM node.
      const tooltipLabel = isGrouped
        ? `${group.length} markers here — click for details`
        : marker.ariaLabel;
      if (tooltipLabel) {
        circle.bindTooltip(tooltipLabel, { direction: 'top', offset: [0, -6] });
      }

      if (isGrouped) {
        // A pre-bound popup would fight with the picker below (both
        // would try to open on the same click), so coincident markers
        // open the picker instead and get their own popup only after
        // being chosen from it.
        circle.on('click', () =>
          openGroupPicker(map, marker.lat, marker.lng, group, onMarkerClickRef.current),
        );
      } else {
        if (marker.popupHtml) {
          circle.bindPopup(marker.popupHtml);
        }
        if (onMarkerClickRef.current) {
          circle.on('click', () => onMarkerClickRef.current?.(marker.id));
        }
      }

      circle.addTo(markerLayer);
      circleMarkersRef.current.set(marker.id, circle);
    }

    // A dashed, non-interactive ring flags each coincident group so the
    // stack is visible before it's ever clicked — real coordinates are
    // never nudged apart, this is purely a visual indicator drawn once
    // per group rather than per marker.
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [{ lat, lng }] = group;
      L.circleMarker([lat, lng], {
        radius: GROUP_RING_RADIUS,
        color: MAP_COLORS.neutral,
        weight: 1.5,
        dashArray: '3 3',
        fill: false,
        interactive: false,
      }).addTo(markerLayer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onMarkerClick is read via a ref specifically so it never re-triggers this redraw
  }, [markers, lines, selectedId]);

  // Fit-to-markers — on mount (once real markers exist) and whenever fitBoundsKey changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || markers.length === 0) return;
    const bounds = L.latLngBounds(markers.map((m) => [m.lat, m.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 10 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-fits only on a real data-identity change (fitBoundsKey), not on every marker array re-render
  }, [fitBoundsKey]);

  return <div ref={containerRef} className="leaflet-map-container" style={{ height }} />;
}
