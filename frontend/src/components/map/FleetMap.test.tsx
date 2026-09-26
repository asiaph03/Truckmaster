import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { FleetMap } from './FleetMap';
import { buildFleetMapData } from './fleetMapData';
import type { FleetMapActiveTruck } from '../../api';

const TRUCK_WITH_LOCATION: FleetMapActiveTruck = {
  truckNumber: 'T-100',
  driverName: 'Jane Driver',
  loadId: 'load-1',
  loadNumber: 'LOAD-000001',
  loadStatus: 'IN_TRANSIT',
  riskStatus: 'NORMAL',
  assignedCarrierId: 'carrier-1',
  lastKnownLocation: {
    city: 'St. Louis',
    state: 'MO',
    description: null,
    updatedAt: '2026-09-26T10:00:00Z',
  },
  currentEta: '2026-09-27T18:00:00Z',
  stops: [
    { sequence: 1, stopType: 'PICKUP', stopPurpose: 'STANDARD', city: 'Chicago', state: 'IL' },
    { sequence: 2, stopType: 'DELIVERY', stopPurpose: 'STANDARD', city: 'Dallas', state: 'TX' },
  ],
};

describe('buildFleetMapData — Dashboard Map Phase (pure logic)', () => {
  it('places a truck with a resolvable last-known-location as a real marker, with a line to a resolvable destination', () => {
    const { markers, lines, unresolvedTrucks } = buildFleetMapData([TRUCK_WITH_LOCATION]);

    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual(
      expect.objectContaining({ id: 'load-1', lat: 38.627, lng: -90.1994 }),
    );
    expect(lines).toHaveLength(1);
    expect(unresolvedTrucks).toEqual([]);
  });

  it('never invents a marker for a truck with no lastKnownLocation — goes to the unresolved list instead', () => {
    const truck = { ...TRUCK_WITH_LOCATION, lastKnownLocation: null };

    const { markers, unresolvedTrucks } = buildFleetMapData([truck]);

    expect(markers).toEqual([]);
    expect(unresolvedTrucks).toHaveLength(1);
    expect(unresolvedTrucks[0].lastKnownLocation).toBeNull();
  });

  it('never invents a marker for a city/state the bundled dataset cannot resolve', () => {
    const truck = {
      ...TRUCK_WITH_LOCATION,
      lastKnownLocation: {
        ...TRUCK_WITH_LOCATION.lastKnownLocation!,
        city: 'Nowhereville',
        state: 'ZZ',
      },
    };

    const { markers, unresolvedTrucks } = buildFleetMapData([truck]);

    expect(markers).toEqual([]);
    expect(unresolvedTrucks).toHaveLength(1);
    expect(unresolvedTrucks[0].lastKnownLocation).not.toBeNull();
  });

  it('still places the truck marker (no line) when the location resolves but the destination does not', () => {
    const truck = {
      ...TRUCK_WITH_LOCATION,
      stops: [
        {
          sequence: 1,
          stopType: 'PICKUP' as const,
          stopPurpose: 'STANDARD' as const,
          city: 'Chicago',
          state: 'IL',
        },
        {
          sequence: 2,
          stopType: 'DELIVERY' as const,
          stopPurpose: 'STANDARD' as const,
          city: 'Nowhereville',
          state: 'ZZ',
        },
      ],
    };

    const { markers, lines } = buildFleetMapData([truck]);

    expect(markers).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it('embeds the driver name/truck number safely — escaping any HTML they might contain', () => {
    const truck = { ...TRUCK_WITH_LOCATION, driverName: '<img src=x onerror=alert(1)>' };

    const { markers } = buildFleetMapData([truck]);

    expect(markers[0].popupHtml).not.toContain('<img src=x onerror=alert(1)>');
    expect(markers[0].popupHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

function renderFleetMap() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FleetMap />
    </QueryClientProvider>,
  );
}

describe('FleetMap component — Dashboard Map Phase', () => {
  it('shows the section title and an empty state when no trucks are dispatched', async () => {
    server.use(
      http.get('/api/v1/dashboard/fleet-map', () =>
        HttpResponse.json({ activeTrucks: [], availableTrucks: [] }),
      ),
    );

    renderFleetMap();

    expect(await screen.findByText('Truck Locations & Destinations')).toBeInTheDocument();
    expect(await screen.findByText('No trucks are currently dispatched.')).toBeInTheDocument();
  });

  it('lists an available truck as plain text, never as a map marker', async () => {
    server.use(
      http.get('/api/v1/dashboard/fleet-map', () =>
        HttpResponse.json({
          activeTrucks: [],
          availableTrucks: [
            {
              truckId: 'truck-2',
              unitNumber: 'T-200',
              carrierId: 'carrier-2',
              carrierLegalName: 'Nurana LLC',
            },
          ],
        }),
      ),
    );

    renderFleetMap();

    expect(await screen.findByText('Available — no active load')).toBeInTheDocument();
    expect(screen.getByText('T-200')).toBeInTheDocument();
  });

  it('shows the shared error state with a working Retry when the fleet-map query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/dashboard/fleet-map', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json({ activeTrucks: [], availableTrucks: [] });
      }),
    );

    renderFleetMap();

    expect(
      await screen.findByText("Couldn't load Truck Locations & Destinations. Please try again."),
    ).toBeInTheDocument();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByText('No trucks are currently dispatched.')).toBeInTheDocument(),
    );
    expect(attempts).toBe(2);
  });
});
