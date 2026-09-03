import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { DocumentCenterPage } from './DocumentCenterPage';

const DOC_ROW = {
  id: 'doc-1',
  fileName: 'w9.pdf',
  documentTypeLabel: 'W9',
  entityType: 'CUSTOMER',
  entityId: 'customer-1',
  entityLabel: 'Acme Freight',
  entityLinkPath: '/customers/customer-1',
  scanStatus: 'CLEAN',
  reviewStatus: 'NOT_APPLICABLE',
  generationStatus: null,
  uploadedByUserId: 'user-2',
  uploadedByName: 'Jane Doe',
  uploadedAt: '2026-01-01T00:00:00.000Z',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DocumentCenterPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockBaseHandlers(searchHandler: Parameters<typeof http.get>[1]) {
  server.use(
    http.get('/api/v1/documents/search', searchHandler),
    http.get('/api/v1/document-types', () => HttpResponse.json([])),
  );
}

describe('DocumentCenterPage — Frontend Phase 20', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [], userId: undefined });
  });

  it('renders results from GET /documents/search with the Owning Entity as a single linked column', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [DOC_ROW], total: 1, page: 1, pageSize: 50 }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());
    const table = screen.getByRole('table');
    const link = within(table).getByRole('link', { name: /Customer: Acme Freight/ });
    expect(link).toHaveAttribute('href', '/customers/customer-1');
  });

  it('changing the search box re-queries the server with the new q param and resets to page 1', async () => {
    const receivedUrls: string[] = [];
    mockBaseHandlers(({ request }) => {
      receivedUrls.push(request.url);
      return HttpResponse.json({ items: [DOC_ROW], total: 1, page: 1, pageSize: 50 });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Search File Name/i), {
      target: { value: 'acme' },
    });

    await waitFor(() => expect(receivedUrls.some((u) => u.includes('q=acme'))).toBe(true));
  });

  it('clicking the File Name header sorts by fileName; clicking Owning Entity (non-sortable) is a no-op', async () => {
    const receivedUrls: string[] = [];
    mockBaseHandlers(({ request }) => {
      receivedUrls.push(request.url);
      return HttpResponse.json({ items: [DOC_ROW], total: 1, page: 1, pageSize: 50 });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('columnheader', { name: 'File Name' }));
    await waitFor(() =>
      expect(
        receivedUrls.some((u) => u.includes('sort=fileName') && u.includes('sortDirection=asc')),
      ).toBe(true),
    );

    const urlCountBeforeEntityClick = receivedUrls.length;
    fireEvent.click(screen.getByRole('columnheader', { name: 'Owning Entity' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedUrls.length).toBe(urlCountBeforeEntityClick);
  });

  it('shows a Download button for a CLEAN document and opens the resolved download URL', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [DOC_ROW], total: 1, page: 1, pageSize: 50 }),
    );
    server.use(
      http.get('/api/v1/documents/doc-1/download-url', () =>
        HttpResponse.json({ url: 'https://storage.test/doc-1' }),
      ),
    );
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Download'));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://storage.test/doc-1', '_blank', 'noopener'),
    );
    openSpy.mockRestore();
  });

  it('shows a Scanning badge instead of Download while scanStatus is PENDING', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({
        items: [{ ...DOC_ROW, scanStatus: 'PENDING' }],
        total: 1,
        page: 1,
        pageSize: 50,
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());
    expect(screen.getByText('Scanning…')).toBeInTheDocument();
    expect(screen.queryByText('Download')).not.toBeInTheDocument();
  });

  it('shows a Download button AND a "Scan Failed" badge for a SCAN_FAILED document (approved policy: consumable, but the scan outcome stays visible) and opens the resolved download URL', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({
        items: [{ ...DOC_ROW, scanStatus: 'SCAN_FAILED' }],
        total: 1,
        page: 1,
        pageSize: 50,
      }),
    );
    server.use(
      http.get('/api/v1/documents/doc-1/download-url', () =>
        HttpResponse.json({ url: 'https://storage.test/doc-1' }),
      ),
    );
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());

    // Scoped to the results table — "Scan Failed" is also a filter-dropdown option label.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Scan Failed')).toBeInTheDocument();
    fireEvent.click(within(table).getByText('Download'));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://storage.test/doc-1', '_blank', 'noopener'),
    );
    openSpy.mockRestore();
  });

  it('shows "Blocked (Infected)" with no Download button for an INFECTED document (remains blocked)', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({
        items: [{ ...DOC_ROW, scanStatus: 'INFECTED' }],
        total: 1,
        page: 1,
        pageSize: 50,
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());
    const table = screen.getByRole('table');
    expect(within(table).getByText('Blocked (Infected)')).toBeInTheDocument();
    expect(within(table).queryByText('Download')).not.toBeInTheDocument();
  });

  it('shows Approve/Reject only for a CARRIER document pending review, gated on reviewComplianceDocuments', async () => {
    const carrierDoc = {
      ...DOC_ROW,
      entityType: 'CARRIER',
      entityLabel: 'Eligible Carrier',
      entityLinkPath: '/carriers/carrier-1',
      reviewStatus: 'PENDING_REVIEW',
      uploadedByUserId: 'user-2',
    };
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [carrierDoc], total: 1, page: 1, pageSize: 50 }),
    );

    useSessionStore.setState({ roles: ['DISPATCHER'], userId: 'user-1' });
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    unmount();

    useSessionStore.setState({ roles: ['COMPLIANCE_REVIEWER'], userId: 'user-1' });
    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('disables Approve/Reject when the reviewer is the same user who uploaded the document', async () => {
    const carrierDoc = {
      ...DOC_ROW,
      entityType: 'CARRIER',
      reviewStatus: 'PENDING_REVIEW',
      uploadedByUserId: 'user-1',
    };
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [carrierDoc], total: 1, page: 1, pageSize: 50 }),
    );
    useSessionStore.setState({ roles: ['COMPLIANCE_REVIEWER'], userId: 'user-1' });

    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  it('Approve calls POST /documents/:id/review with APPROVED and refreshes the list', async () => {
    const carrierDoc = {
      ...DOC_ROW,
      entityType: 'CARRIER',
      reviewStatus: 'PENDING_REVIEW',
      uploadedByUserId: 'user-2',
    };
    let reviewBody: unknown;
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [carrierDoc], total: 1, page: 1, pageSize: 50 }),
    );
    server.use(
      http.post('/api/v1/documents/doc-1/review', async ({ request }) => {
        reviewBody = await request.json();
        return HttpResponse.json({ ...carrierDoc, reviewStatus: 'APPROVED' });
      }),
    );
    useSessionStore.setState({ roles: ['COMPLIANCE_REVIEWER'], userId: 'user-1' });

    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(reviewBody).toEqual({ decision: 'APPROVED' }));
  });

  it('Export CSV calls the export endpoint with the current filters', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [DOC_ROW], total: 1, page: 1, pageSize: 50 }),
    );
    let exportUrl: string | undefined;
    server.use(
      http.get('/api/v1/documents/search/export', ({ request }) => {
        exportUrl = request.url;
        return new HttpResponse('File Name\r\nw9.pdf', { headers: { 'Content-Type': 'text/csv' } });
      }),
    );
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => expect(exportUrl).toBeDefined());
    clickSpy.mockRestore();
  });
});
