import { useRef, useState } from 'react';
import { FileText, Loader2, Upload, X } from 'lucide-react';
import { Button } from './Button';
import {
  rateConfirmationExtractionApi,
  type ExtractedRateConfirmationData,
} from '../../api/rateConfirmationExtraction';
import './RateConfirmationDropzone.css';

export type RateConfirmationDropzoneStatus =
  'idle' | 'uploading' | 'scanning' | 'extracting' | 'complete' | 'error';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60; // ~2 minutes — extraction (an LLM call) can reasonably take longer than a malware scan
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB, matches the backend's InitiateRateConfirmationExtractionDto cap

export interface RateConfirmationDropzoneProps {
  disabled?: boolean;
  /**
   * Called once with the full extraction result on COMPLETE, plus the
   * extractionId it came from (needed by LoadCreatePage to persist a
   * Load Draft referencing the same underlying Document — see
   * loadDraftsApi.create). Never auto-submits anything — the caller
   * decides what to do with it.
   */
  onExtracted: (data: ExtractedRateConfirmationData, extractionId: string) => void;
}

/**
 * Rate Confirmation → New Load auto-populate feature — the only
 * drag-and-drop file target in this frontend (no existing precedent to
 * extend; the only other drag-and-drop in the app is Kanban/Calendar
 * card-reordering, unrelated). Mirrors `FileUploadField`'s established
 * state-machine/polling shape, with one extra phase (`extracting`) and a
 * drop target added on top of its click-to-browse fallback.
 *
 * Never calls loadsApi.create or any Load-creation endpoint — this
 * component's only output is the `onExtracted` callback, which the
 * caller uses purely to pre-fill client-side form state for the user to
 * review before manually submitting.
 */
export function RateConfirmationDropzone({
  disabled = false,
  onExtracted,
}: RateConfirmationDropzoneProps) {
  const [status, setStatus] = useState<RateConfirmationDropzoneStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStatus('idle');
    setErrorMessage(null);
    setFileName(null);
    setExtractionId(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function pollUntilResolved(id: string) {
    for (let i = 0; i < MAX_POLLS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const result = await rateConfirmationExtractionApi.getStatus(id);

      if (result.scanStatus === 'INFECTED') {
        setStatus('error');
        setErrorMessage('This file was flagged by malware scanning and cannot be used.');
        return;
      }
      if (result.scanStatus === 'PENDING') {
        continue; // still scanning
      }
      // CLEAN or SCAN_FAILED — both consumable per approved policy. A
      // SCAN_FAILED file was never actually verified clean by
      // Cloudmersive, but a failed scan *attempt* doesn't block usage
      // here — only an actual INFECTED detection does — so extraction
      // proceeds exactly as it would for CLEAN.

      setStatus('extracting');

      if (result.extractionStatus === 'FAILED') {
        setStatus('error');
        setErrorMessage(result.extractionError ?? 'Extraction failed.');
        return;
      }
      if (result.extractionStatus === 'COMPLETE' && result.data) {
        setStatus('complete');
        onExtracted(result.data, id);
        return;
      }
      // extractionStatus is PENDING or NOT_STARTED — keep polling.
    }
    // Gives up client-side polling after ~2 minutes; nothing keeps
    // running server-side beyond the job's own bounded retry attempts,
    // so surface this as a failure rather than silently going idle.
    setStatus('error');
    setErrorMessage('Extraction is taking longer than expected. Please retry.');
  }

  async function handleFile(file: File) {
    setErrorMessage(null);

    if (file.type !== 'application/pdf') {
      setStatus('error');
      setErrorMessage('Only PDF files are supported.');
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setStatus('error');
      setErrorMessage('File is too large — the maximum size is 20 MB.');
      return;
    }

    setFileName(file.name);
    setStatus('uploading');
    try {
      const { extractionId: id, uploadUrl } = await rateConfirmationExtractionApi.initiate({
        fileName: file.name,
        mimeType: 'application/pdf',
        fileSizeBytes: file.size,
      });
      setExtractionId(id);

      await rateConfirmationExtractionApi.putFileToUploadUrl(uploadUrl, file);

      setStatus('scanning');
      await rateConfirmationExtractionApi.confirm(id);
      await pollUntilResolved(id);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed.');
    }
  }

  async function handleRetry() {
    if (!extractionId) return;
    setStatus('extracting');
    setErrorMessage(null);
    try {
      await rateConfirmationExtractionApi.retry(extractionId);
      await pollUntilResolved(extractionId);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Retry failed.');
    }
  }

  const busy = status === 'uploading' || status === 'scanning' || status === 'extracting';
  const statusLabel =
    status === 'uploading'
      ? 'Uploading…'
      : status === 'scanning'
        ? 'Scanning for malware…'
        : status === 'extracting'
          ? 'Reading Rate Confirmation…'
          : null;

  return (
    <div className="detail-card">
      <h2 className="detail-card-title">Rate Confirmation</h2>
      <div
        className={[
          'rate-confirmation-dropzone',
          dragActive ? 'rate-confirmation-dropzone-active' : '',
          disabled || busy ? 'rate-confirmation-dropzone-disabled' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !busy) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !disabled && !busy) handleFile(file);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="rate-confirmation-dropzone-input"
          disabled={disabled || busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />

        {status === 'idle' ? (
          <div className="rate-confirmation-dropzone-empty">
            <Upload size={20} strokeWidth={1.5} />
            <span>Drag &amp; drop your Rate Confirmation PDF here</span>
            <span className="rate-confirmation-dropzone-hint">
              Text-based PDF only — scanned or image-only PDFs aren&apos;t supported.
            </span>
            <span className="rate-confirmation-dropzone-or">or</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              Choose PDF
            </Button>
          </div>
        ) : (
          <div className="rate-confirmation-dropzone-status">
            <FileText size={18} strokeWidth={1.5} />
            <span className="rate-confirmation-dropzone-filename">{fileName}</span>
            {busy ? (
              <span className="rate-confirmation-dropzone-progress">
                <Loader2 size={14} className="rate-confirmation-dropzone-spin" />
                {statusLabel}
              </span>
            ) : null}
            {status === 'complete' ? (
              <span className="rate-confirmation-dropzone-complete">Extracted — review below</span>
            ) : null}
            {!busy ? (
              <Button
                type="button"
                variant="tertiary"
                size="sm"
                onClick={reset}
                title="Remove and choose a different file"
              >
                <X size={14} />
                Remove
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {status === 'error' && errorMessage ? (
        <div className="rate-confirmation-dropzone-error">
          <span>{errorMessage}</span>
          {extractionId ? (
            <Button type="button" variant="secondary" size="sm" onClick={handleRetry}>
              Retry
            </Button>
          ) : null}
          <Button type="button" variant="tertiary" size="sm" onClick={reset}>
            Choose a different file
          </Button>
        </div>
      ) : null}
    </div>
  );
}
