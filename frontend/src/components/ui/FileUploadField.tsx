import { useRef, useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { Button } from './Button';
import './FileUploadField.css';

export type FileUploadStatus = 'idle' | 'uploading' | 'scanning' | 'clean' | 'infected' | 'error';

export interface FileUploadFieldProps {
  label?: string;
  accept?: string;
  disabled?: boolean;
  /** Orchestrates initiate → PUT → confirm; returns the new document's id. */
  onUpload: (file: File) => Promise<string>;
  /** Polled every 2s after confirm until it resolves to a non-PENDING status. */
  onCheckScanStatus: (
    documentId: string,
  ) => Promise<'PENDING' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED'>;
  onComplete?: (documentId: string, status: 'CLEAN' | 'INFECTED' | 'SCAN_FAILED') => void;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;

/**
 * Wraps the two-phase upload contract (initiate → PUT to a presigned URL
 * → confirm → async malware scan) as one component. UI_UX_DESIGN.md
 * (Load Detail Documents tab, §5.4.4 line 950): a row shows a small
 * "Scanning…" indicator until CLEAN; INFECTED/SCAN_FAILED show a
 * blocked/quarantined state with no download option.
 */
export function FileUploadField({
  label = 'Upload',
  accept = 'application/pdf,image/jpeg,image/png',
  disabled = false,
  onUpload,
  onCheckScanStatus,
  onComplete,
}: FileUploadFieldProps) {
  const [status, setStatus] = useState<FileUploadStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function pollUntilResolved(documentId: string) {
    setStatus('scanning');
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const result = await onCheckScanStatus(documentId);
      if (result !== 'PENDING') {
        setStatus(result === 'CLEAN' ? 'clean' : 'infected');
        onComplete?.(documentId, result);
        return;
      }
    }
    // Gives up polling client-side after ~1 minute; the document itself
    // keeps scanning server-side and will show correctly on next reload.
    setStatus('idle');
  }

  async function handleFileSelected(file: File) {
    setErrorMessage(null);
    setStatus('uploading');
    try {
      const documentId = await onUpload(file);
      await pollUntilResolved(documentId);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const busy = status === 'uploading' || status === 'scanning';

  return (
    <div className="file-upload-field">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="file-upload-input-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelected(file);
        }}
        disabled={disabled || busy}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <Loader2 size={14} className="file-upload-spin" />
        ) : (
          <Upload size={14} strokeWidth={1.5} />
        )}
        {status === 'uploading' ? 'Uploading…' : status === 'scanning' ? 'Scanning…' : label}
      </Button>
      {status === 'error' && errorMessage ? (
        <span className="file-upload-error">{errorMessage}</span>
      ) : null}
    </div>
  );
}
