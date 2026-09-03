import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { LoadDraftsPage } from './LoadDraftsPage';

const DRAFTS = [
  {
    id: 'draft-1',
    customerId: 'cust-1',
    customerLegalName: 'Basciani Express',
    customerStatus: 'PROSPECT',
    rateConfirmationDocumentId: 'doc-1',
    rateConfirmationFileName: 'ratecon-1.pdf',
    createdAt: '2026-09-04T00:00:00.000Z',
  },
  {
    id: 'draft-2',
    customerId: 'cust-2',
    customerLegalName: 'Acme Freight LLC',
    customerStatus: 'ACTIVE',
    rateConfirmationDocumentId: 'doc-2',
    rateConfirmationFileName: 'ratecon-2.pdf',
    createdAt: '2026-09-03T00:00:00.000Z',
  },
];

function renderPage(drafts: typeof DRAFTS = DRAFTS) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(http.get('/api/v1/load-drafts', () => HttpResponse.json(drafts)));
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LoadDraftsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoadDraftsPage', () => {
  it("lists every draft with the customer's live status", async () => {
    renderPage();

    await screen.findByText('Basciani Express');
    expect(screen.getByText('Acme Freight LLC')).toBeInTheDocument();
    expect(screen.getByText('PROSPECT')).toBeInTheDocument();
    expect(screen.getByText('Ready to Book')).toBeInTheDocument();
    expect(screen.getByText('ratecon-1.pdf')).toBeInTheDocument();
  });

  it('shows the empty state when there are no drafts', async () => {
    renderPage([]);

    await waitFor(() => expect(screen.getByText(/No Load Drafts/)).toBeInTheDocument());
  });

  it('Delete removes a draft and refetches the list', async () => {
    let deleteCalls = 0;
    server.use(
      http.delete('/api/v1/load-drafts/draft-1', () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();
    await screen.findByText('Basciani Express');

    fireEvent.click(screen.getAllByText('Delete')[0]);

    await waitFor(() => expect(deleteCalls).toBe(1));
  });
});
