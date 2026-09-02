import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { CreateCustomerModal } from './CreateCustomerModal';

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

describe('CreateCustomerModal — Rate Confirmation extraction feature (Customer creation workflow)', () => {
  it('prefills from initialValues, and every field remains editable', () => {
    render(
      <CreateCustomerModal
        open
        initialValues={{ legalName: 'Extracted Co', billingCity: 'Austin' }}
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );

    expect((screen.getByLabelText(/^Legal Name/) as HTMLInputElement).value).toBe('Extracted Co');
    expect((screen.getByLabelText(/^City/) as HTMLInputElement).value).toBe('Austin');

    fireEvent.change(screen.getByLabelText(/^Legal Name/), { target: { value: 'Edited Co' } });
    expect((screen.getByLabelText(/^Legal Name/) as HTMLInputElement).value).toBe('Edited Co');
  });

  it('shows the possible-duplicate modal on 409 and does not create a duplicate; Continue Anyway resubmits with acknowledgeDuplicates', async () => {
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
        return HttpResponse.json(
          { id: 'new-1', legalName: 'Acme Freight', status: 'PROSPECT' },
          { status: 201 },
        );
      }),
    );

    let created: unknown;
    render(
      <CreateCustomerModal
        open
        onClose={() => {}}
        onCreated={(c) => {
          created = c;
        }}
      />,
    );

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create Customer' }));

    await waitFor(() => expect(screen.getByText('Possible Duplicate')).toBeInTheDocument());
    expect(screen.getByText(/Acme Freight LLC/)).toBeInTheDocument();
    // Only one creation attempt so far — the conflict blocked it, no duplicate was created.
    expect(receivedBodies).toHaveLength(1);
    expect(created).toBeUndefined();

    fireEvent.click(screen.getByText('Continue Anyway'));

    await waitFor(() => expect(receivedBodies).toHaveLength(2));
    expect(receivedBodies[0].acknowledgeDuplicates).toBe(false);
    expect(receivedBodies[1].acknowledgeDuplicates).toBe(true);
    await waitFor(() => expect(created).toBeDefined());
  });

  it('does not call onCreated or the API when never submitted (Customer creation stays explicit)', () => {
    let apiCalls = 0;
    server.use(
      http.post('/api/v1/customers', () => {
        apiCalls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    let created = false;
    render(
      <CreateCustomerModal
        open
        initialValues={{ legalName: 'Extracted Co' }}
        onClose={() => {}}
        onCreated={() => (created = true)}
      />,
    );

    expect(apiCalls).toBe(0);
    expect(created).toBe(false);
  });
});
