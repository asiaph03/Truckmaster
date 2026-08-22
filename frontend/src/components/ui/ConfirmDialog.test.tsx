import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('confirms immediately when no reason is required', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Deactivate User"
        message="Are you sure?"
        confirmLabel="Deactivate User"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate User' }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('blocks confirm until a reason is entered when requireReason is set', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Reject Document"
        message="This will reject the document."
        confirmLabel="Reject Document"
        requireReason
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    const confirmButton = screen.getByRole('button', { name: 'Reject Document' });
    fireEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Illegible scan' } });
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith('Illegible scan');
  });

  it('is not backdrop-dismissible when a reason is required, but is otherwise', () => {
    const onCancelRequired = vi.fn();
    const { container: requiredContainer, unmount } = render(
      <ConfirmDialog
        open
        title="Reject Document"
        message="This will reject the document."
        confirmLabel="Reject"
        requireReason
        onCancel={onCancelRequired}
        onConfirm={() => {}}
      />,
    );
    fireEvent.mouseDown(requiredContainer.querySelector('.modal-backdrop')!);
    expect(onCancelRequired).not.toHaveBeenCalled();
    unmount();

    const onCancelPlain = vi.fn();
    const { container: plainContainer } = render(
      <ConfirmDialog
        open
        title="Deactivate User"
        message="Are you sure?"
        confirmLabel="Deactivate User"
        onCancel={onCancelPlain}
        onConfirm={() => {}}
      />,
    );
    fireEvent.mouseDown(plainContainer.querySelector('.modal-backdrop')!);
    expect(onCancelPlain).toHaveBeenCalledTimes(1);
  });
});
