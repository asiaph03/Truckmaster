import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { CustomerCreatePage } from './CustomerCreatePage';

// Required fields render their `*` marker inside the same <label>, so
// the accessible name is e.g. "Legal Name*" — match with a regex prefix.
function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/^Legal Name/), { target: { value: 'Acme Freight' } });
  fireEvent.change(screen.getByLabelText(/^Address Line 1/), { target: { value: '1 Main St' } });
  fireEvent.change(screen.getByLabelText(/^City/), { target: { value: 'Dallas' } });
  fireEvent.change(screen.getByLabelText(/^State/), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText(/^ZIP/), { target: { value: '75201' } });
  fireEvent.change(screen.getByLabelText(/^Contact Name/), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'jane@acme.test' } });
  fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '555-0100' } });
}

describe('CustomerCreatePage — duplicate warning (Workflow 2 §2.2)', () => {
  it('shows the possible-duplicate modal on 409 and re-submits with acknowledgeDuplicates on Continue Anyway', async () => {
    const receivedBodies: { acknowledgeDuplicates?: boolean }[] = [];
    server.use(
      http.post('/api/v1/customers', async ({ request }) => {
        const body = (await request.json()) as { acknowledgeDuplicates?: boolean };
        receivedBodies.push(body);
        if (!body.acknowledgeDuplicates) {
          return HttpResponse.json(
            {
              error: {
                code: 'CONFLICT',
                message: 'One or more possible duplicate customers were found.',
                details: {
                  reasonCode: 'POSSIBLE_DUPLICATE_CUSTOMER',
                  matches: [
                    {
                      customerId: 'existing-1',
                      legalName: 'Acme Freight LLC',
                      matchedOn: ['legalName'],
                    },
                  ],
                },
              },
            },
            { status: 409 },
          );
        }
        return HttpResponse.json({ id: 'new-1', legalName: 'Acme Freight' }, { status: 201 });
      }),
    );

    render(
      <MemoryRouter>
        <CustomerCreatePage />
      </MemoryRouter>,
    );

    fillRequiredFields();
    fireEvent.click(screen.getByText('Create Customer'));

    await waitFor(() => expect(screen.getByText('Possible Duplicate')).toBeInTheDocument());
    expect(screen.getByText(/Acme Freight LLC/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Continue Anyway'));

    await waitFor(() => expect(receivedBodies).toHaveLength(2));
    expect(receivedBodies[0].acknowledgeDuplicates).toBe(false);
    expect(receivedBodies[1].acknowledgeDuplicates).toBe(true);
  });
});
