import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import { ToastViewport } from '../../../components/ui';
import { ComplianceTab } from './ComplianceTab';
import type { AppDocument, Carrier } from '../../../api';

const CARRIER: Carrier = {
  id: 'carrier-1',
  legalName: 'MG Cargo Inc',
  dba: '',
  mcNumber: '042939',
  dotNumber: '1234567',
  addressLine1: '200 Dock Rd',
  city: 'Tampa',
  state: 'FL',
  zip: '33602',
  primaryContactName: 'Sam Broker',
  primaryContactPhone: '555-0200',
  primaryContactEmail: 'sam@mgcargo.test',
  status: 'ACTIVE',
  assignmentEligible: true,
  ineligibilityReasons: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  contacts: [],
  insuranceRecords: [],
  fmcsaVerifications: [],
  serviceAreas: [],
  factoringInfo: null,
  drivers: [],
  trucks: [],
  trailers: [],
};

const COMPLIANCE_DOC_TYPES = [
  {
    id: 'dt-w9',
    organizationId: null,
    category: 'CARRIER_COMPLIANCE',
    code: 'W9',
    label: 'W-9',
    requiresReview: true,
    isSystemDefault: true,
  },
  {
    id: 'dt-agreement',
    organizationId: null,
    category: 'CARRIER_COMPLIANCE',
    code: 'CARRIER_AGREEMENT',
    label: 'Notice of Assignment',
    requiresReview: true,
    isSystemDefault: true,
  },
  {
    id: 'dt-mc',
    organizationId: null,
    category: 'CARRIER_COMPLIANCE',
    code: 'MC_AUTHORITY',
    label: 'MC Authority',
    requiresReview: true,
    isSystemDefault: true,
  },
];

function makeAppDocument(overrides: Partial<AppDocument>): AppDocument {
  return {
    id: 'w9-doc-1',
    // Deliberately different from `id` — a family id equal to its own
    // document id would let a regression back to passing `.id` slip past
    // the regression test below undetected (matches DocumentsTab.test.tsx's
    // own makeAppDocument convention exactly).
    documentFamilyId: 'family-w9-1',
    entityType: 'CARRIER',
    entityId: 'carrier-1',
    documentTypeId: 'dt-w9',
    fileName: 'w9.pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: '1024',
    fileStorageKey: 'org_1/documents/w9-doc-1',
    versionNumber: 1,
    isCurrentVersion: true,
    scanStatus: 'CLEAN',
    reviewStatus: 'APPROVED',
    uploadedByUserId: 'user-1',
    uploadedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderTab(carrier: Carrier, documents: AppDocument[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.get('/api/v1/document-types', () => HttpResponse.json(COMPLIANCE_DOC_TYPES)),
    http.get('/api/v1/documents', () => HttpResponse.json(documents)),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <ComplianceTab carrier={carrier} />
      <ToastViewport />
    </QueryClientProvider>,
  );
}

function selectReplacementFile(): { input: HTMLInputElement; file: File } {
  const replaceButton = screen.getByText('Replace');
  const wrapper = replaceButton.closest('.file-upload-field') as HTMLElement;
  const input = wrapper.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['content'], 'replacement.pdf', { type: 'application/pdf' });
  return { input, file };
}

describe('ComplianceTab — required document checklist', () => {
  it('renders Upload for a required type with no current document, and Replace once one exists', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    const w9 = makeAppDocument({});
    renderTab(CARRIER, [w9]);

    await waitFor(() => expect(screen.getByText('W-9')).toBeInTheDocument());
    expect(screen.getByText('Replace')).toBeInTheDocument();
    // The other two required types have no current document yet.
    expect(screen.getAllByText('Upload')).toHaveLength(2);
  });
});

// Document Replace hardening (Task #2) — Compliance Replace must pass the
// document's documentFamilyId, never its own document id (the two are
// deliberately different values in makeAppDocument's default). This test
// would fail if ComplianceTab's Replace regressed back to passing `.id`,
// exactly the defect confirmed present before this fix.
describe('ComplianceTab — Replace passes documentFamilyId, not document id', () => {
  it("Replace uploads with existingDocumentFamilyId set to the document's documentFamilyId, not its document id", async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    const w9 = makeAppDocument({});
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/v1/carriers/carrier-1/documents', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          document: makeAppDocument({ id: 'w9-doc-2', scanStatus: 'PENDING' }),
          uploadUrl: '/mock-upload-url',
        });
      }),
      http.put('/mock-upload-url', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/documents/w9-doc-2/confirm', () =>
        HttpResponse.json(makeAppDocument({ id: 'w9-doc-2', scanStatus: 'PENDING' })),
      ),
    );
    renderTab(CARRIER, [w9]);
    await waitFor(() => expect(screen.getByText('Replace')).toBeInTheDocument());

    const { input, file } = selectReplacementFile();
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(receivedBody).toBeDefined());
    expect(receivedBody).toMatchObject({
      documentTypeId: 'dt-w9',
      existingDocumentFamilyId: 'family-w9-1',
    });
    expect(receivedBody?.existingDocumentFamilyId).not.toBe('w9-doc-1');
  });

  it('Download and Approve/Reject continue to use the document id, unaffected by the Replace fix', async () => {
    useSessionStore.setState({ roles: ['ADMIN', 'COMPLIANCE_REVIEWER'] });
    const w9 = makeAppDocument({
      reviewStatus: 'PENDING_REVIEW',
      uploadedByUserId: 'someone-else',
    });
    let approvedId: string | undefined;
    server.use(
      http.post('/api/v1/documents/w9-doc-1/review', async ({ request }) => {
        const body = (await request.json()) as { decision: string };
        approvedId = 'w9-doc-1';
        expect(body.decision).toBe('APPROVED');
        return HttpResponse.json(makeAppDocument({ reviewStatus: 'APPROVED' }));
      }),
    );
    renderTab(CARRIER, [w9]);
    await waitFor(() => expect(screen.getByText('Approve')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => expect(approvedId).toBe('w9-doc-1'));
  });
});

describe('ComplianceTab — Record FMCSA Verification failure handling (Task #5)', () => {
  it('shows a toast error and keeps the modal open when the record request fails, and never shows success', async () => {
    useSessionStore.setState({ roles: ['ADMIN', 'COMPLIANCE_REVIEWER'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/fmcsa-verification', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderTab(CARRIER, []);

    await waitFor(() => expect(screen.getByText('Record Verification')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Record Verification'));
    fireEvent.change(screen.getByLabelText(/^Verification Date/), {
      target: { value: '2026-01-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('FMCSA verification recorded.')).not.toBeInTheDocument();
  });
});
