import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { ComplianceQueuePage } from './ComplianceQueuePage';

const PENDING_DOC = {
  id: 'doc-1',
  entityId: 'carrier-1',
  carrierLegalName: 'Acme Trucking',
  documentType: { id: 'w9', label: 'W9' },
  fileName: 'w9.pdf',
  uploadedAt: '2026-01-01T00:00:00.000Z',
  uploadedByUserId: 'user-2',
  scanStatus: 'CLEAN',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ComplianceQueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ComplianceQueuePage — query error state', () => {
  it('shows QueryErrorState with a working Retry when the pending-review query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/documents/pending-review', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json([PENDING_DOC]);
      }),
    );

    renderPage();

    expect(
      await screen.findByText("Couldn't load the Compliance Review Queue. Please try again."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText('w9.pdf')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
