import { useRef, useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { Button } from './Button';
import './FileUploadField.css';

export interface ImportFileUploadFieldProps {
  label?: string;
  disabled?: boolean;
  /** Bulk Import files go through a plain upload → server-side parse, never the malware-scan pipeline (approved Decision 9) — unlike FileUploadField, there's no scan-status polling contract to reuse. */
  onUpload: (file: File) => Promise<void>;
}

/**
 * Approved technical design (Decision 14) — `FileUploadField` is hard-
 * coupled to the Document malware-scan two-phase contract
 * (`onCheckScanStatus`), which doesn't apply to import source files.
 * Same visual/interaction shape (button → spinner → error), simpler
 * one-phase contract.
 */
export function ImportFileUploadField({
  label = 'Choose File',
  disabled = false,
  onUpload,
}: ImportFileUploadFieldProps) {
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelected(file: File) {
    setErrorMessage(null);
    setUploading(true);
    try {
      await onUpload(file);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="file-upload-field">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="file-upload-input-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelected(file);
        }}
        disabled={disabled || uploading}
      />
      <Button
        variant="secondary"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 size={14} className="file-upload-spin" />
        ) : (
          <Upload size={14} strokeWidth={1.5} />
        )}
        {uploading ? 'Uploading…' : label}
      </Button>
      {errorMessage ? <span className="file-upload-error">{errorMessage}</span> : null}
    </div>
  );
}
