import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportFileUploadField } from './ImportFileUploadField';

describe('ImportFileUploadField', () => {
  it('calls onUpload with the selected file and shows an uploading state while pending', async () => {
    let resolveUpload: () => void = () => {};
    const onUpload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    render(<ImportFileUploadField onUpload={onUpload} />);

    const file = new File(['a,b\n1,2\n'], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    expect(onUpload).toHaveBeenCalledWith(file);
    await waitFor(() => expect(screen.getByText('Uploading…')).toBeInTheDocument());

    resolveUpload();
    await waitFor(() => expect(screen.getByText('Choose File')).toBeInTheDocument());
  });

  it('shows an error message on upload failure rather than throwing', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('Could not parse file.'));
    render(<ImportFileUploadField onUpload={onUpload} />);

    const file = new File(['bad'], 'bad.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Could not parse file.')).toBeInTheDocument());
  });
});
