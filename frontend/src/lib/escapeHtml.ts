/**
 * Dashboard Map Phase — Leaflet's `bindPopup` takes a raw HTML string,
 * not a React tree (see `LeafletMap.tsx`'s header comment for why). Every
 * value interpolated into that string that ultimately comes from
 * free-text user input (driver name, truck/trailer number, city/state)
 * must be escaped here first — without this, a dispatcher's own
 * free-text entry (e.g. a Truck Number containing `<img onerror=...>`)
 * would render as live HTML in every other user's browser viewing the
 * Fleet Map, a stored XSS vector.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
