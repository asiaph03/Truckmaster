import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { SendDriverDispatchEmailModal } from './SendDriverDispatchEmailModal';
import type { DriverDispatchEmailPreview } from '../../../api';

function renderModal(onSent: () => void = () => {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SendDriverDispatchEmailModal open loadId="load-1" onClose={() => {}} onSent={onSent} />
    </QueryClientProvider>,
  );
}

function mockPreview(overrides: Partial<DriverDispatchEmailPreview> = {}) {
  const preview: DriverDispatchEmailPreview = {
    recipientEmail: 'julia@carrier.test',
    subject: 'Dispatch Details — Load #LOAD-000001',
    body: '🚛 Carrier: MG CARGO INC\n🔗 Driver/Dispatch: Julia — (773) 870-1332',
    attachmentAvailable: true,
    attachmentFileName: 'Nurana RC 2434269.pdf',
    ...overrides,
  };
  server.use(
    http.get('/api/v1/loads/load-1/driver-dispatch-email-preview', () =>
      HttpResponse.json(preview),
    ),
  );
  return preview;
}

function getToggle(): HTMLInputElement {
  return screen.getByLabelText('Attach Original Rate Confirmation') as HTMLInputElement;
}

describe('SendDriverDispatchEmailModal — Driver Dispatch Email feature', () => {
  it('shows the on-file driver email as the recipient, with subject/message/attachment preview', async () => {
    mockPreview();
    renderModal();

    await screen.findByText('julia@carrier.test');
    expect(screen.getByText('Dispatch Details — Load #LOAD-000001')).toBeInTheDocument();
    expect(screen.getByText(/Driver\/Dispatch: Julia/)).toBeInTheDocument();
    expect(screen.getByText('Attachment: Nurana RC 2434269.pdf')).toBeInTheDocument();
    // No manual email input shown when a driver email is already on file.
    expect(screen.queryByLabelText(/Recipient Email/)).not.toBeInTheDocument();
  });

  it('prompts for a manual recipient email when no driver email is on file', async () => {
    mockPreview({ recipientEmail: null });
    renderModal();

    await screen.findByLabelText(/Recipient Email/);
    expect(screen.queryByText('julia@carrier.test')).not.toBeInTheDocument();
  });

  it('rejects an invalid manually entered email and does not send', async () => {
    mockPreview({ recipientEmail: null });
    let sendRequests = 0;
    server.use(
      http.post('/api/v1/loads/load-1/send-driver-dispatch-email', () => {
        sendRequests += 1;
        return HttpResponse.json({ recipientEmail: 'x' });
      }),
    );
    renderModal();

    const input = await screen.findByLabelText(/Recipient Email/);
    fireEvent.change(input, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByText('Send Email'));

    await waitFor(() =>
      expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument(),
    );
    expect(sendRequests).toBe(0);
  });

  it('sends with a valid manually entered email and reports success', async () => {
    mockPreview({ recipientEmail: null });
    const receivedBodies: Record<string, unknown>[] = [];
    server.use(
      http.post('/api/v1/loads/load-1/send-driver-dispatch-email', async ({ request }) => {
        receivedBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ recipientEmail: 'manual@example.com' });
      }),
    );
    let sent = false;
    renderModal(() => {
      sent = true;
    });

    const input = await screen.findByLabelText(/Recipient Email/);
    fireEvent.change(input, { target: { value: 'manual@example.com' } });
    fireEvent.click(screen.getByText('Send Email'));

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0].manualRecipientEmail).toBe('manual@example.com');
    expect(sent).toBe(true);
  });

  it('the Send button works when a driver email is already on file (no manual input needed)', async () => {
    mockPreview();
    const receivedBodies: Record<string, unknown>[] = [];
    server.use(
      http.post('/api/v1/loads/load-1/send-driver-dispatch-email', async ({ request }) => {
        receivedBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ recipientEmail: 'julia@carrier.test' });
      }),
    );
    renderModal();

    await screen.findByText('julia@carrier.test');
    fireEvent.click(screen.getByText('Send Email'));

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0].manualRecipientEmail).toBeUndefined();
  });

  it('shows failed-send feedback and does not call onSent when the API call fails', async () => {
    mockPreview();
    server.use(
      http.post('/api/v1/loads/load-1/send-driver-dispatch-email', () =>
        HttpResponse.json(
          { error: { code: 'BUSINESS_RULE_ERROR', message: 'No email is on file.' } },
          { status: 422 },
        ),
      ),
    );
    let sent = false;
    renderModal(() => {
      sent = true;
    });

    await screen.findByText('julia@carrier.test');
    fireEvent.click(screen.getByText('Send Email'));

    await waitFor(() => expect(screen.getByText('No email is on file.')).toBeInTheDocument());
    expect(sent).toBe(false);
  });

  describe('Attach Original Rate Confirmation toggle', () => {
    it('defaults to checked when an uploaded Rate Confirmation is available', async () => {
      mockPreview({ attachmentAvailable: true, attachmentFileName: 'Nurana RC 2434269.pdf' });
      renderModal();

      await screen.findByText('julia@carrier.test');
      expect(getToggle().checked).toBe(true);
      expect(screen.getByText('Attachment: Nurana RC 2434269.pdf')).toBeInTheDocument();
    });

    it('defaults to unchecked when no uploaded Rate Confirmation is available', async () => {
      mockPreview({ attachmentAvailable: false, attachmentFileName: null });
      renderModal();

      await screen.findByText('julia@carrier.test');
      expect(getToggle().checked).toBe(false);
      expect(
        screen.getByText('Original uploaded Rate Confirmation not available'),
      ).toBeInTheDocument();
      // Never shows an "attachment available" badge when there isn't one.
      expect(screen.queryByText(/^Attachment:/)).not.toBeInTheDocument();
    });

    it('Send is never disabled by attachment availability alone — the checkbox, not availability, gates the request', async () => {
      mockPreview({ attachmentAvailable: false, attachmentFileName: null });
      renderModal();

      await screen.findByText('julia@carrier.test');
      expect(screen.getByText('Send Email').closest('button')).not.toBeDisabled();
    });

    it('checked ON: sends attachRateConfirmation: true', async () => {
      mockPreview({ attachmentAvailable: true, attachmentFileName: 'Nurana RC 2434269.pdf' });
      const receivedBodies: Record<string, unknown>[] = [];
      server.use(
        http.post('/api/v1/loads/load-1/send-driver-dispatch-email', async ({ request }) => {
          receivedBodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({ recipientEmail: 'julia@carrier.test' });
        }),
      );
      renderModal();

      await screen.findByText('julia@carrier.test');
      expect(getToggle().checked).toBe(true); // default-on
      fireEvent.click(screen.getByText('Send Email'));

      await waitFor(() => expect(receivedBodies).toHaveLength(1));
      expect(receivedBodies[0].attachRateConfirmation).toBe(true);
    });

    it('unchecking sends attachRateConfirmation: false', async () => {
      mockPreview({ attachmentAvailable: true, attachmentFileName: 'Nurana RC 2434269.pdf' });
      const receivedBodies: Record<string, unknown>[] = [];
      server.use(
        http.post('/api/v1/loads/load-1/send-driver-dispatch-email', async ({ request }) => {
          receivedBodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({ recipientEmail: 'julia@carrier.test' });
        }),
      );
      renderModal();

      await screen.findByText('julia@carrier.test');
      fireEvent.click(getToggle());
      expect(getToggle().checked).toBe(false);
      fireEvent.click(screen.getByText('Send Email'));

      await waitFor(() => expect(receivedBodies).toHaveLength(1));
      expect(receivedBodies[0].attachRateConfirmation).toBe(false);
    });

    it('checked but unavailable: send fails clearly with a server error, never silently succeeds without the attachment', async () => {
      mockPreview({ attachmentAvailable: false, attachmentFileName: null });
      server.use(
        http.post('/api/v1/loads/load-1/send-driver-dispatch-email', () =>
          HttpResponse.json(
            {
              error: {
                code: 'BUSINESS_RULE_ERROR',
                message:
                  'The original uploaded Rate Confirmation PDF for this Load is not available.',
              },
            },
            { status: 422 },
          ),
        ),
      );
      let sent = false;
      renderModal(() => {
        sent = true;
      });

      await screen.findByText('julia@carrier.test');
      fireEvent.click(getToggle()); // check it despite unavailability
      expect(getToggle().checked).toBe(true);
      fireEvent.click(screen.getByText('Send Email'));

      await waitFor(() =>
        expect(
          screen.getByText(
            'The original uploaded Rate Confirmation PDF for this Load is not available.',
          ),
        ).toBeInTheDocument(),
      );
      expect(sent).toBe(false);
    });

    it('unchecked with no uploaded Rate Confirmation available: send still succeeds', async () => {
      mockPreview({ attachmentAvailable: false, attachmentFileName: null });
      const receivedBodies: Record<string, unknown>[] = [];
      server.use(
        http.post('/api/v1/loads/load-1/send-driver-dispatch-email', async ({ request }) => {
          receivedBodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({ recipientEmail: 'julia@carrier.test' });
        }),
      );
      let sent = false;
      renderModal(() => {
        sent = true;
      });

      await screen.findByText('julia@carrier.test');
      expect(getToggle().checked).toBe(false); // default-off since unavailable
      fireEvent.click(screen.getByText('Send Email'));

      await waitFor(() => expect(receivedBodies).toHaveLength(1));
      expect(receivedBodies[0].attachRateConfirmation).toBe(false);
      expect(sent).toBe(true);
    });
  });
});
