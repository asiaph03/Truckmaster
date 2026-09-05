import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import { ToastViewport } from '../../../components/ui';
import { InsuranceTab } from './InsuranceTab';
import type { Carrier } from '../../../api';

// An existing record (with its coiDocumentId already on file) lets the
// modal open in "Edit" mode with coiDocumentId pre-populated from state
// init (`useState(record?.coiDocumentId ?? null)`), so this test can
// exercise the addInsurance failure path directly without also driving
// FileUploadField's real upload+poll-for-scan-result flow (untested
// elsewhere in this codebase, and unrelated to the Task #5 defect here).
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
  insuranceRecords: [
    {
      id: 'ins-1',
      coverageType: 'AUTO_LIABILITY',
      coverageAmount: '1000000.00',
      insuranceCompany: 'Old Insurance Co',
      effectiveDate: '2025-01-01',
      expirationDate: '2026-01-01',
      coiDocumentId: 'coi-doc-1',
    },
  ],
};

const COI_DOC_TYPES = [
  {
    id: 'dt-coi',
    organizationId: null,
    category: 'CARRIER_COMPLIANCE',
    code: 'COI',
    label: 'Certificate of Insurance',
    requiresReview: false,
    isSystemDefault: true,
  },
];

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.get('/api/v1/document-types', () => HttpResponse.json(COI_DOC_TYPES)),
    http.get('/api/v1/documents', () => HttpResponse.json([])),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <InsuranceTab carrier={CARRIER} />
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('InsuranceTab — Add/Edit Insurance failure handling (Task #5)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('shows a toast error and keeps the modal open when the save request fails, and never shows success', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/insurance', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderTab();

    await waitFor(() => expect(screen.getAllByText('Edit')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Edit')[0]);

    fireEvent.change(screen.getAllByLabelText(/^Coverage Amount/)[0], {
      target: { value: '2000000' },
    });
    fireEvent.change(screen.getAllByLabelText(/^Insurance Company/)[0], {
      target: { value: 'New Insurance Co' },
    });
    fireEvent.change(screen.getAllByLabelText(/^Effective Date/)[0], {
      target: { value: '2026-01-01' },
    });
    fireEvent.change(screen.getAllByLabelText(/^Expiration Date/)[0], {
      target: { value: '2027-01-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('New Insurance Co')).toBeInTheDocument();
    expect(screen.queryByText(/insurance saved\./)).not.toBeInTheDocument();
  });
});
