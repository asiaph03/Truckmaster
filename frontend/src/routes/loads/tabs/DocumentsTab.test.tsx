import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { DocumentsTab } from './DocumentsTab';
import { ToastViewport } from '../../../components/ui';
import type { AppDocument, Load, Stop } from '../../../api';

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

function renderTab(load: Load, loadDocuments: AppDocument[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.get('/api/v1/document-types', () => HttpResponse.json(DOC_TYPES)),
    http.get('/api/v1/documents', () => HttpResponse.json(loadDocuments)),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <DocumentsTab load={load} />
      <ToastViewport />
    </QueryClientProvider>,
  );
}

function makeAppDocument(overrides: Partial<AppDocument>): AppDocument {
  return {
    id: 'doc-1',
    // Deliberately different from `id` — a family id equal to its own
    // document id would let a regression back to passing `.id` slip past
    // the "L" Replace test below undetected.
    documentFamilyId: 'family-doc-1',
    entityType: 'LOAD',
    entityId: 'load-1',
    documentTypeId: 'dt-bol',
    fileName: 'bol.pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: '1024',
    fileStorageKey: 'org_1/documents/doc-1',
    versionNumber: 1,
    isCurrentVersion: true,
    scanStatus: 'CLEAN',
    reviewStatus: 'NOT_APPLICABLE',
    uploadedByUserId: 'user-1',
    uploadedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
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

describe('DocumentsTab — scan-status consumption gate (isDocumentConsumable)', () => {
  it('shows a Download button AND a "Scan Failed" badge for a SCAN_FAILED Load-level document, and download opens the resolved URL', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1', scanStatus: 'SCAN_FAILED' });
    server.use(
      http.get('/api/v1/documents/doc-1/download-url', () =>
        HttpResponse.json({ url: 'https://storage.test/doc-1' }),
      ),
    );
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderTab(load, [doc]);

    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());
    expect(screen.getByText('Scan Failed')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://storage.test/doc-1', '_blank', 'noopener'),
    );
    openSpy.mockRestore();
  });

  it('shows "Blocked (Infected)" with no Download button for an INFECTED Load-level document (remains blocked)', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1', scanStatus: 'INFECTED' });

    renderTab(load, [doc]);

    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());
    expect(screen.getByText('Blocked (Infected)')).toBeInTheDocument();
    expect(screen.queryByText('Download')).not.toBeInTheDocument();
  });

  it('shows a Scanning badge (no Download) for a PENDING Load-level document (remains blocked)', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1', scanStatus: 'PENDING' });

    renderTab(load, [doc]);

    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());
    expect(screen.getByText('Scanning…')).toBeInTheDocument();
    expect(screen.queryByText('Download')).not.toBeInTheDocument();
  });
});

describe('DocumentsTab — Load-Level Documents Replace + Delete', () => {
  function selectReplacementFile(): { input: HTMLInputElement; file: File } {
    const replaceButton = screen.getByText('Replace');
    const wrapper = replaceButton.closest('.file-upload-field') as HTMLElement;
    const input = wrapper.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['content'], 'replacement.pdf', { type: 'application/pdf' });
    return { input, file };
  }

  // K. Actions column renders Download/Replace/Delete.
  it('renders an Actions column with Download, Replace, and Delete for a current, CLEAN Load-level document', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1', scanStatus: 'CLEAN' });
    renderTab(load, [doc]);

    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Download')).toBeInTheDocument();
    expect(screen.getByText('Replace')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  // L. Replace passes the correct existingDocumentFamilyId — the row's
  // documentFamilyId, never its own document id (the two are deliberately
  // different values in makeAppDocument's default, so this test would fail
  // if Replace regressed back to passing doc.id).
  it("Replace uploads with existingDocumentFamilyId set to the row's documentFamilyId, not its document id, keeping the same document type", async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({
      id: 'doc-1',
      documentFamilyId: 'family-doc-1',
      documentTypeId: 'dt-bol',
      scanStatus: 'CLEAN',
    });
    let receivedCreateBody: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/v1/documents', async ({ request }) => {
        receivedCreateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          document: makeAppDocument({ id: 'doc-2', scanStatus: 'PENDING' }),
          uploadUrl: '/mock-upload-url',
        });
      }),
      http.put('/mock-upload-url', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/documents/doc-2/confirm', () =>
        HttpResponse.json(makeAppDocument({ id: 'doc-2', scanStatus: 'PENDING' })),
      ),
    );
    renderTab(load, [doc]);
    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());

    const { input, file } = selectReplacementFile();
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(receivedCreateBody).toBeDefined());
    expect(receivedCreateBody).toMatchObject({
      entityType: 'LOAD',
      entityId: 'load-1',
      documentTypeId: 'dt-bol',
      existingDocumentFamilyId: 'family-doc-1',
    });
    expect(receivedCreateBody?.existingDocumentFamilyId).not.toBe('doc-1');
  });

  // M. Delete opens confirmation dialog.
  it('clicking Delete opens the confirmation dialog naming the document, and does not call the API yet', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1', fileName: 'rate-confirmation.pdf' });
    let deleteWasCalled = false;
    server.use(
      http.delete('/api/v1/documents/doc-1', () => {
        deleteWasCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderTab(load, [doc]);
    await waitFor(() => expect(screen.getByText('rate-confirmation.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Delete'));

    expect(await screen.findByText('Delete document?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This will permanently delete "rate-confirmation.pdf" and all of its versions. This action cannot be undone.',
      ),
    ).toBeInTheDocument();
    expect(deleteWasCalled).toBe(false);
  });

  // N. Canceling confirmation does not call DELETE.
  it('canceling the confirmation dialog closes it and never calls the DELETE endpoint', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1' });
    let deleteWasCalled = false;
    server.use(
      http.delete('/api/v1/documents/doc-1', () => {
        deleteWasCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderTab(load, [doc]);
    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Delete'));
    await screen.findByText('Delete document?');
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByText('Delete document?')).not.toBeInTheDocument());
    expect(deleteWasCalled).toBe(false);
  });

  // O. Confirming delete calls the correct DELETE endpoint.
  // P. Successful delete refreshes the list and shows success feedback.
  it('confirming delete calls DELETE /documents/:id, refreshes the list, and shows a success toast', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1', fileName: 'bol.pdf' });
    let deletedId: string | undefined;
    let documentDeleted = false;
    renderTab(load, [doc]);
    // Registered after renderTab so these take priority over renderTab's own
    // static /api/v1/documents handler for every subsequent request,
    // including the refetch triggered by a successful delete.
    server.use(
      http.get('/api/v1/documents', () => HttpResponse.json(documentDeleted ? [] : [doc])),
      http.delete('/api/v1/documents/:id', ({ params }) => {
        deletedId = params.id as string;
        documentDeleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Delete'));
    await screen.findByText('Delete document?');
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deletedId).toBe('doc-1'));
    expect(await screen.findByText('bol.pdf deleted.')).toBeInTheDocument();
    // Confirms the list was actually refetched (not just a local optimistic
    // removal) — the row is gone because a fresh GET reflects the deletion.
    await waitFor(() => expect(screen.queryByText('bol.pdf')).not.toBeInTheDocument());
  });

  // Q. Dependency error is displayed cleanly.
  it("shows the backend's clean Load Draft dependency error via the existing toast pattern, never a raw failure", async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1' });
    server.use(
      http.delete('/api/v1/documents/doc-1', () =>
        HttpResponse.json(
          {
            error: {
              code: 'BUSINESS_RULE_ERROR',
              message:
                'Cannot delete document because it is associated with a Load Draft. Delete the Load Draft first, then try again.',
            },
          },
          { status: 422 },
        ),
      ),
    );
    renderTab(load, [doc]);
    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Delete'));
    await screen.findByText('Delete document?');
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText(
        'Cannot delete document because it is associated with a Load Draft. Delete the Load Draft first, then try again.',
      ),
    ).toBeInTheDocument();
    // The dialog stays open on failure — nothing was silently discarded.
    expect(screen.getByText('Delete document?')).toBeInTheDocument();
  });

  // R. Existing Download behavior still works — covered by the pre-existing
  // "scan-status consumption gate" describe block above, unmodified;
  // re-asserted here in the Actions-column context for completeness.
  it('Download still opens the resolved URL from the Actions column, unchanged', async () => {
    const load = makeLoad([]);
    const doc = makeAppDocument({ id: 'doc-1', scanStatus: 'CLEAN' });
    server.use(
      http.get('/api/v1/documents/doc-1/download-url', () =>
        HttpResponse.json({ url: 'https://storage.test/doc-1' }),
      ),
    );
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderTab(load, [doc]);
    await waitFor(() => expect(screen.getByText('bol.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Download'));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://storage.test/doc-1', '_blank', 'noopener'),
    );
    openSpy.mockRestore();
  });
});
