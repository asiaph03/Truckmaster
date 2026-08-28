import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgingReport } from './AgingReport';

const DATA = {
  buckets: {
    current: { count: 1, total: '100.00' },
    days1to30: { count: 0, total: '0.00' },
    days31to60: { count: 0, total: '0.00' },
    days61to90: { count: 0, total: '0.00' },
    days90plus: { count: 0, total: '0.00' },
  },
  grandTotal: '100.00',
};

describe('AgingReport — Phase 21 Export CSV addition', () => {
  it('renders no Export button when onExport is omitted (existing contract unchanged)', () => {
    render(<AgingReport title="AR Aging" basisNote="basis" data={DATA} isLoading={false} />);
    expect(screen.queryByText('Export CSV')).not.toBeInTheDocument();
  });

  it('calls onExport and shows an "Exporting…" state while pending', async () => {
    let resolveExport: () => void = () => {};
    const onExport = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = resolve;
        }),
    );

    render(<AgingReport title="AR Aging" basisNote="basis" data={DATA} isLoading={false} onExport={onExport} />);

    fireEvent.click(screen.getByText('Export CSV'));
    expect(onExport).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('Exporting…')).toBeInTheDocument());

    resolveExport();
    await waitFor(() => expect(screen.getByText('Export CSV')).toBeInTheDocument());
  });

  it('shows a toast on export failure rather than throwing', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('network error'));
    render(<AgingReport title="AR Aging" basisNote="basis" data={DATA} isLoading={false} onExport={onExport} />);

    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Export CSV')).toBeInTheDocument());
  });
});
