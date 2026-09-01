import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { DocumentsTab } from './DocumentsTab';
import type { Load, Stop } from '../../../api';

const DOC_TYPES = [
  {
    id: 'dt-rc',
    organizationId: null,
    category: 'LOAD',
    code: 'RATE_CONFIRMATION',
    label: 'Rate Confirmation',
    requiresReview: false,
    isSystemDefault: true,
  },
  {
    id: 'dt-bol',
    organizationId: null,
    category: 'LOAD',
    code: 'BOL',
    label: 'Bill of Lading',
    requiresReview: false,
    isSystemDefault: true,
  },
  {
    id: 'dt-pod',
    organizationId: null,
    category: 'LOAD',
    code: 'POD',
    label: 'Proof of Delivery',
    requiresReview: false,
    isSystemDefault: true,
  },
  {
    id: 'dt-pop',
    organizationId: null,
    category: 'LOAD',
    code: 'POP',
    label: 'Proof of Pickup',
    requiresReview: false,
    isSystemDefault: true,
  },
];

function makeStop(overrides: Partial<Stop>): Stop {
  return {
    id: `stop-${overrides.sequence}`,
    loadId: 'load-1',
    sequence: 1,
    stopType: 'PICKUP',
    stopPurpose: 'STANDARD',
    companyName: 'Test Co',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    status: 'PENDING',
    ...overrides,
  };
}

function makeLoad(stops: Stop[]): Load {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000001',
    customerId: 'cust-1',
    bookingSource: 'DIRECT',
    status: 'DISPATCHED',
    equipmentType: 'DRY_VAN',
    customerRate: '1000',
    rateSource: 'MANUAL',
    rateAgreementId: null,
    podStatus: 'NOT_RECEIVED',
    riskStatus: 'NORMAL',
    invoiced: false,
    createdByUserId: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stops,
    sourcingAttempts: [],
    dispatchRecord: null,
    checkCalls: [],
    chargeLineItems: [],
  };
}

function renderTab(load: Load) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.get('/api/v1/document-types', () => HttpResponse.json(DOC_TYPES)),
    http.get('/api/v1/documents', () => HttpResponse.json([])),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <DocumentsTab load={load} />
    </QueryClientProvider>,
  );
}

describe('DocumentsTab — Proof of Pickup (POP) / Proof of Delivery (POD) by Stop', () => {
  it('a PICKUP stop renders Proof of Pickup with an Upload POP control', async () => {
    const load = makeLoad([
      makeStop({ sequence: 1, stopType: 'PICKUP', city: 'Dallas' }),
      makeStop({ sequence: 2, stopType: 'DELIVERY', city: 'Chicago' }),
    ]);
    renderTab(load);

    const row = (await screen.findByText(/Stop 1 —/)).closest('.detail-card') as HTMLElement;
    expect(within(row).getByText(/Proof of Pickup/)).toBeInTheDocument();
    expect(within(row).getByText('Upload POP')).toBeInTheDocument();
    expect(within(row).queryByText('Upload POD')).not.toBeInTheDocument();
  });

  it('a DELIVERY stop renders Proof of Delivery with an Upload POD control', async () => {
    const load = makeLoad([
      makeStop({ sequence: 1, stopType: 'PICKUP', city: 'Dallas' }),
      makeStop({ sequence: 2, stopType: 'DELIVERY', city: 'Chicago' }),
    ]);
    renderTab(load);

    const row = (await screen.findByText(/Stop 2 —/)).closest('.detail-card') as HTMLElement;
    expect(within(row).getByText(/Proof of Delivery/)).toBeInTheDocument();
    expect(within(row).getByText('Upload POD')).toBeInTheDocument();
    expect(within(row).queryByText('Upload POP')).not.toBeInTheDocument();
  });

  it('multiple pickup stops each independently render their own Upload POP control', async () => {
    const load = makeLoad([
      makeStop({ sequence: 1, stopType: 'PICKUP', city: 'Dallas' }),
      makeStop({ sequence: 2, stopType: 'PICKUP', city: 'Fort Worth' }),
      makeStop({ sequence: 3, stopType: 'DELIVERY', city: 'Chicago' }),
    ]);
    renderTab(load);

    await screen.findByText(/Stop 1 —/);
    expect(screen.getAllByText('Upload POP')).toHaveLength(2);
    expect(screen.getAllByText('Upload POD')).toHaveLength(1);
  });

  it('multiple delivery stops each independently render their own Upload POD control', async () => {
    const load = makeLoad([
      makeStop({ sequence: 1, stopType: 'PICKUP', city: 'Dallas' }),
      makeStop({ sequence: 2, stopType: 'DELIVERY', city: 'Springfield' }),
      makeStop({ sequence: 3, stopType: 'DELIVERY', city: 'Chicago' }),
    ]);
    renderTab(load);

    await screen.findByText(/Stop 1 —/);
    expect(screen.getAllByText('Upload POD')).toHaveLength(2);
    expect(screen.getAllByText('Upload POP')).toHaveLength(1);
  });

  it('mixed/interleaved pickup and delivery stops each render the correct control regardless of position', async () => {
    const load = makeLoad([
      makeStop({ sequence: 1, stopType: 'PICKUP', city: 'Dallas' }),
      makeStop({ sequence: 2, stopType: 'DELIVERY', city: 'Springfield' }),
      makeStop({ sequence: 3, stopType: 'PICKUP', city: 'St. Louis' }),
      makeStop({ sequence: 4, stopType: 'DELIVERY', city: 'Chicago' }),
      makeStop({ sequence: 5, stopType: 'PICKUP', city: 'Memphis' }),
    ]);
    renderTab(load);

    await screen.findByText(/Stop 1 —/);
    const expectations: Array<[number, 'POP' | 'POD']> = [
      [1, 'POP'],
      [2, 'POD'],
      [3, 'POP'],
      [4, 'POD'],
      [5, 'POP'],
    ];
    for (const [sequence, code] of expectations) {
      const row = screen
        .getByText(new RegExp(`Stop ${sequence} —`))
        .closest('.detail-card') as HTMLElement;
      expect(within(row).getByText(`Upload ${code}`)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Upload POP')).toHaveLength(3);
    expect(screen.getAllByText('Upload POD')).toHaveLength(2);
  });

  it('a RETURN-purpose PICKUP stop still renders Upload POP, labeled "(Return)" — stopType-only logic needs no changes', async () => {
    const load = makeLoad([
      makeStop({ sequence: 1, stopType: 'PICKUP', stopPurpose: 'STANDARD', city: 'Dallas' }),
      makeStop({ sequence: 2, stopType: 'DELIVERY', stopPurpose: 'STANDARD', city: 'Chicago' }),
      makeStop({ sequence: 3, stopType: 'PICKUP', stopPurpose: 'RETURN', city: 'Chicago' }),
      makeStop({ sequence: 4, stopType: 'DELIVERY', stopPurpose: 'RETURN', city: 'Dallas' }),
    ]);
    renderTab(load);

    const pickupRow = (await screen.findByText(/Stop 3 —.*\(Return\)/)).closest(
      '.detail-card',
    ) as HTMLElement;
    expect(within(pickupRow).getByText(/Proof of Pickup/)).toBeInTheDocument();
    expect(within(pickupRow).getByText('Upload POP')).toBeInTheDocument();

    const deliveryRow = screen
      .getByText(/Stop 4 —.*\(Return\)/)
      .closest('.detail-card') as HTMLElement;
    expect(within(deliveryRow).getByText(/Proof of Delivery/)).toBeInTheDocument();
    expect(within(deliveryRow).getByText('Upload POD')).toBeInTheDocument();

    // Standard stops are unaffected — no "(Return)" suffix.
    expect(screen.queryByText(/Stop 1 —.*\(Return\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stop 2 —.*\(Return\)/)).not.toBeInTheDocument();
  });

  it('POP and POD are excluded from the generic Load-Level Documents type dropdown', async () => {
    const load = makeLoad([
      makeStop({ sequence: 1, stopType: 'PICKUP', city: 'Dallas' }),
      makeStop({ sequence: 2, stopType: 'DELIVERY', city: 'Chicago' }),
    ]);
    renderTab(load);

    await screen.findByText('Bill of Lading');
    const select = screen.getByLabelText('Document Type') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toContain('Bill of Lading');
    expect(optionLabels).toContain('Rate Confirmation');
    expect(optionLabels).not.toContain('Proof of Delivery');
    expect(optionLabels).not.toContain('Proof of Pickup');
  });
});
