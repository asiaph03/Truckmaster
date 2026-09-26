/**
 * Dashboard Map Phase — literal hex values mirroring `styles/tokens.css`
 * exactly (Leaflet's SVG renderer sets `fill`/`stroke` as raw SVG
 * attributes, not inline `style`, so a `var(--token)` string won't
 * resolve there the way it does on an HTML element — these constants
 * are the one place that trade-off is made, kept in lockstep with the
 * token file rather than inventing a separate palette).
 */
export const MAP_COLORS = {
  brand: '#1a2bc3',
  success: '#157f3c',
  warning: '#b4770b',
  danger: '#c4293a',
  info: '#0e7490',
  neutral: '#9297a3',
} as const;

/**
 * A truck's marker color: `riskStatus` always wins when it's not NORMAL
 * (an at-risk/delayed load is the more operationally important signal),
 * otherwise colored the same way the existing `statusBadgeMap` colors
 * `Load.status` — DISPATCHED/PICKUP/BOOKED-family as brand, IN_TRANSIT as
 * info, DELIVERED/CLOSED as success. No new colors introduced.
 */
export function truckMarkerColor(loadStatus: string, riskStatus: string): string {
  if (riskStatus === 'DELAYED') return MAP_COLORS.danger;
  if (riskStatus === 'AT_RISK') return MAP_COLORS.warning;
  if (loadStatus === 'IN_TRANSIT') return MAP_COLORS.info;
  if (loadStatus === 'DELIVERED' || loadStatus === 'CLOSED') return MAP_COLORS.success;
  return MAP_COLORS.brand;
}

/** Stop marker color for `LoadRouteMap` — matches the brief's Completed/Current/Upcoming states to this product's own status colors, not a new visual system. */
export function stopMarkerColor(state: 'completed' | 'current' | 'upcoming'): string {
  if (state === 'completed') return MAP_COLORS.success;
  if (state === 'current') return MAP_COLORS.info;
  return MAP_COLORS.neutral;
}
