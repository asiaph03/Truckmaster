import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { LogCommunicationActivityModal } from './LogCommunicationActivityModal';

describe('LogCommunicationActivityModal — Frontend Phase 7', () => {
  it('shows validation errors and never submits when required fields are empty', async () => {
    let requestCount = 0;
    server.use(
      http.post('/api/v1/loads/load-1/communication-activities', () => {
        requestCount += 1;
        return HttpResponse.json({ id: 'comm-1' }, { status: 201 });
      }),
    );

    render(
      <LogCommunicationActivityModal open loadId="load-1" onClose={() => {}} onAdded={() => {}} />,
    );

    fireEvent.click(screen.getByText('Log Activity'));

    await waitFor(() => expect(screen.getByText('Activity type is required.')).toBeInTheDocument());
    expect(screen.getByText('Notes are required.')).toBeInTheDocument();
    expect(requestCount).toBe(0);
  });

  it('submits activityType as free text, direction as optional, and calls onAdded', async () => {
    const receivedBodies: Record<string, unknown>[] = [];
    server.use(
      http.post('/api/v1/loads/load-1/communication-activities', async ({ request }) => {
        receivedBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 'comm-1' }, { status: 201 });
      }),
    );

    let added = false;
    render(
      <LogCommunicationActivityModal
        open
        loadId="load-1"
        onClose={() => {}}
        onAdded={() => {
          added = true;
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Activity type\/method/), {
      target: { value: 'Called Carrier' },
    });
    fireEvent.change(screen.getByLabelText(/^Notes\/details/), {
      target: { value: 'Confirmed pickup appointment.' },
    });
    fireEvent.click(screen.getByText('Log Activity'));

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0].activityType).toBe('Called Carrier');
    expect(receivedBodies[0].notes).toBe('Confirmed pickup appointment.');
    // Direction left at its default ('') is omitted, not sent as an empty string.
    expect(receivedBodies[0].direction).toBeUndefined();
    expect(added).toBe(true);
  });

  it('sends an explicit direction when selected', async () => {
    const receivedBodies: Record<string, unknown>[] = [];
    server.use(
      http.post('/api/v1/loads/load-1/communication-activities', async ({ request }) => {
        receivedBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 'comm-1' }, { status: 201 });
      }),
    );

    render(
      <LogCommunicationActivityModal open loadId="load-1" onClose={() => {}} onAdded={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText(/^Activity type\/method/), {
      target: { value: 'Sent Rate Confirmation' },
    });
    fireEvent.change(screen.getByLabelText(/^Direction/), { target: { value: 'OUTBOUND' } });
    fireEvent.change(screen.getByLabelText(/^Notes\/details/), {
      target: { value: 'Emailed rate confirmation.' },
    });
    fireEvent.click(screen.getByText('Log Activity'));

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0].direction).toBe('OUTBOUND');
  });
});
