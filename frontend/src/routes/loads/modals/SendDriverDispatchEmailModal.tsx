import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { loadsApi } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Badge, Button, Modal, TextField, Toggle } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

const emailSchema = z.string().email('Enter a valid email address.');

/**
 * Driver Dispatch Email feature — recipient/subject/message preview is
 * fetched from GET /loads/:id/driver-dispatch-email-preview, the exact
 * same deterministic formatter and server-side recipient resolution the
 * send action itself uses (CarrierSourcingService.resolveDriverDispatchContext),
 * so nothing here is generated independently on the frontend and nothing
 * shown here can drift from what actually gets sent. The carrier's email
 * is never offered as a recipient option anywhere in this modal. A
 * manually entered email is only ever collected when no on-file driver
 * email was resolved, is validated before Send is enabled, and is never
 * persisted anywhere by this modal — it is sent once, as part of this one
 * request, and forgotten.
 *
 * The "Attach Original Rate Confirmation" toggle controls
 * `attachRateConfirmation` — always sent explicitly, since the server is
 * the real gate (never trusts this checkbox alone). `preview.attachmentAvailable`
 * now describes the ORIGINAL user-uploaded Rate Confirmation (never the
 * system-generated one, which this feature never attaches).
 */
export function SendDriverDispatchEmailModal({
  open,
  loadId,
  onClose,
  onSent,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const [manualEmail, setManualEmail] = useState('');
  const [manualEmailError, setManualEmailError] = useState<string | null>(null);
  const [attachRateConfirmation, setAttachRateConfirmation] = useState(false);
  const [sending, setSending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    data: preview,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['driver-dispatch-email-preview', loadId],
    queryFn: () => loadsApi.previewDriverDispatchEmail(loadId),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setManualEmail('');
      setManualEmailError(null);
      setServerError(null);
    }
  }, [open]);

  // Default the toggle to checked only once we know an eligible uploaded
  // Rate Confirmation actually exists — re-evaluated each time a fresh
  // preview loads (e.g. reopening the modal for a different Load).
  useEffect(() => {
    if (preview) setAttachRateConfirmation(preview.attachmentAvailable);
  }, [preview]);

  const hasDriverEmail = Boolean(preview?.recipientEmail);

  async function onSend() {
    setServerError(null);
    let manualRecipientEmail: string | undefined;
    if (!hasDriverEmail) {
      const parsed = emailSchema.safeParse(manualEmail);
      if (!parsed.success) {
        setManualEmailError(parsed.error.issues[0]?.message ?? 'Enter a valid email address.');
        return;
      }
      manualRecipientEmail = parsed.data;
    }

    setSending(true);
    try {
      await loadsApi.sendDriverDispatchEmail(loadId, {
        manualRecipientEmail,
        attachRateConfirmation,
      });
      toast.success('Driver dispatch email sent.');
      onSent();
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setSending(false);
    }
  }

  const canSend = !isLoading && (hasDriverEmail || manualEmail.trim().length > 0);

  return (
    <Modal
      open={open}
      title="Send Driver Dispatch Email"
      onClose={onClose}
      size="form"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSend} loading={sending} disabled={!canSend}>
            Send Email
          </Button>
        </>
      }
    >
      {isLoading ? <p>Loading preview…</p> : null}
      {isError ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          Failed to load the dispatch email preview.
        </div>
      ) : null}
      {serverError ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          {serverError}
        </div>
      ) : null}

      {preview ? (
        <>
          {hasDriverEmail ? (
            <div>
              <div className="detail-field-label">Recipient</div>
              <div className="detail-field-value">{preview.recipientEmail}</div>
            </div>
          ) : (
            <TextField
              label="Recipient Email"
              type="email"
              required
              helperText="No email is on file for this driver — enter one for this send only. It will not be saved."
              value={manualEmail}
              onChange={(e) => {
                setManualEmail(e.target.value);
                setManualEmailError(null);
              }}
              error={manualEmailError ?? undefined}
              placeholder="driver@example.com"
            />
          )}

          <div style={{ marginTop: 'var(--space-3)' }}>
            <div className="detail-field-label">Subject</div>
            <div className="detail-field-value">{preview.subject}</div>
          </div>

          <div style={{ marginTop: 'var(--space-3)' }}>
            <div className="detail-field-label">Message</div>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                margin: 0,
                background: 'var(--surface-secondary)',
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              {preview.body}
            </pre>
          </div>

          <div style={{ marginTop: 'var(--space-3)' }}>
            <Toggle
              label="Attach Original Rate Confirmation"
              checked={attachRateConfirmation}
              onChange={(e) => setAttachRateConfirmation(e.target.checked)}
            />
            <div style={{ marginTop: 'var(--space-2)' }}>
              {preview.attachmentAvailable ? (
                <Badge label={`Attachment: ${preview.attachmentFileName}`} color="neutral" />
              ) : (
                <Badge label="Original uploaded Rate Confirmation not available" color="danger" />
              )}
            </div>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
