import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { AddInternalNoteModal } from './AddInternalNoteModal';

describe('AddInternalNoteModal — Frontend Phase 7', () => {
  it('shows a validation error and never submits when content is empty', async () => {
    let requestCount = 0;
    server.use(
      http.post('/api/v1/loads/load-1/internal-notes', () => {
        requestCount += 1;
        return HttpResponse.json({ id: 'note-1' }, { status: 201 });
      }),
    );

    render(<AddInternalNoteModal open loadId="load-1" onClose={() => {}} onAdded={() => {}} />);

    fireEvent.click(screen.getByText('Add Note'));

    await waitFor(() => expect(screen.getByText('Note text is required.')).toBeInTheDocument());
    expect(requestCount).toBe(0);
  });

  it('submits the exact expected body and calls onAdded on success', async () => {
    const receivedBodies: { content?: string }[] = [];
    server.use(
      http.post('/api/v1/loads/load-1/internal-notes', async ({ request }) => {
        receivedBodies.push((await request.json()) as { content?: string });
        return HttpResponse.json({ id: 'note-1' }, { status: 201 });
      }),
    );

    let added = false;
    render(
      <AddInternalNoteModal
        open
        loadId="load-1"
        onClose={() => {}}
        onAdded={() => {
          added = true;
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Note text/), {
      target: { value: 'Called shipper about detention.' },
    });
    fireEvent.click(screen.getByText('Add Note'));

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0]).toEqual({ content: 'Called shipper about detention.' });
    expect(added).toBe(true);
  });
});
