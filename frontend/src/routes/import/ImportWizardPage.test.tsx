import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ImportWizardPage } from './ImportWizardPage';

function renderWizard(initialEntries: string[] = ['/import']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <ImportWizardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ImportWizardPage — Bulk CSV/Excel Import', () => {
  beforeEach(() => {
    useSessionStore.setState({ roles: ['ADMIN'] as never });
  });

  it('only offers entity types the user has permission to import', () => {
    useSessionStore.setState({ roles: ['SALES_BOOKING'] as never });
    renderWizard();
    const select = screen.getByLabelText('Entity Type') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toContain('Customers');
    expect(optionLabels).not.toContain('Carriers'); // Sales/Booking is not in the Carrier role set
  });

  it('preselects the entity type from ?entityType= when the user has permission', () => {
    renderWizard(['/import?entityType=CARRIER']);
    const select = screen.getByLabelText('Entity Type') as HTMLSelectElement;
    expect(select.value).toBe('CARRIER');
  });

  it('upload → confirm-upload → mapping step, with the suggested mapping pre-filled', async () => {
    server.use(
      http.post('/api/v1/import-batches', () =>
        HttpResponse.json(
          {
            importBatch: { id: 'batch-1', entityType: 'CUSTOMER', status: 'UPLOADED' },
            uploadUrl: 'https://upload.example/signed',
          },
          { status: 201 },
        ),
      ),
      http.put('https://upload.example/signed', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/import-batches/batch-1/confirm-upload', () =>
        HttpResponse.json(
          {
            headers: ['Legal Name', 'City'],
            suggestedMapping: { 'Legal Name': 'legalName', City: null },
            targetFields: [
              { key: 'legalName', label: 'Legal Name', required: true },
              { key: 'billingCity', label: 'Billing City', required: true },
            ],
          },
          { status: 201 },
        ),
      ),
    );

    renderWizard(['/import?entityType=CUSTOMER']);
    const file = new File(['Legal Name,City\nAcme,Dallas\n'], 'customers.csv', {
      type: 'text/csv',
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Map columns')).toBeInTheDocument());
    const rows = screen.getAllByRole('row');
    const legalNameRow = rows.find((r) => within(r).queryByText('Legal Name'));
    expect(legalNameRow).toBeDefined();
    const select = within(legalNameRow!).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('legalName'); // suggested mapping pre-filled
  });

  it('Preview shows a duplicate warning with an "Import anyway" toggle that calls the acknowledge endpoint', async () => {
    server.use(
      http.post('/api/v1/import-batches', () =>
        HttpResponse.json(
          {
            importBatch: { id: 'batch-1', entityType: 'CUSTOMER', status: 'UPLOADED' },
            uploadUrl: 'https://upload.example/signed',
          },
          { status: 201 },
        ),
      ),
      http.put('https://upload.example/signed', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/import-batches/batch-1/confirm-upload', () =>
        HttpResponse.json(
          {
            headers: ['Legal Name'],
            suggestedMapping: { 'Legal Name': 'legalName' },
            targetFields: [{ key: 'legalName', label: 'Legal Name', required: true }],
          },
          { status: 201 },
        ),
      ),
      http.patch('/api/v1/import-batches/batch-1/mapping', () =>
        HttpResponse.json({
          id: 'batch-1',
          status: 'VALIDATED',
          validRowCount: 1,
          invalidRowCount: 0,
          totalRows: 1,
        }),
      ),
      http.get('/api/v1/import-batches/batch-1/rows', () =>
        HttpResponse.json({
          items: [
            {
              id: 'row-1',
              rowNumber: 1,
              rawData: { 'Legal Name': 'Acme Inc' },
              mappedData: { legalName: 'Acme Inc' },
              status: 'VALID',
              errors: null,
              duplicateWarning: [{ customerId: 'existing-1', legalName: 'Acme Inc' }],
              acknowledgeDuplicate: false,
              createdEntityId: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    let acknowledgeCalled = false;
    server.use(
      http.patch('/api/v1/import-batches/batch-1/rows/row-1', async ({ request }) => {
        const body = (await request.json()) as { acknowledgeDuplicate: boolean };
        acknowledgeCalled = body.acknowledgeDuplicate === true;
        return HttpResponse.json({ id: 'row-1' });
      }),
    );

    renderWizard(['/import?entityType=CUSTOMER']);
    const file = new File(['Legal Name\nAcme Inc\n'], 'customers.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Map columns')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Continue'));

    await waitFor(() => expect(screen.getByText('Possible Duplicate')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Import anyway'));
    await waitFor(() => expect(acknowledgeCalled).toBe(true));
  });
});
