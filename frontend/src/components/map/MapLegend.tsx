import './MapLegend.css';

export interface MapLegendItem {
  color: string;
  label: string;
}

/** Static color key for a map's markers — shared by `FleetMap` and `LoadRouteMap` so their color/label pairs stay in one place instead of being re-typed at each call site. */
export function MapLegend({ items }: { items: MapLegendItem[] }) {
  return (
    <div className="map-legend">
      {items.map((item) => (
        <span className="map-legend-item" key={item.label}>
          <span
            className="map-legend-dot"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
