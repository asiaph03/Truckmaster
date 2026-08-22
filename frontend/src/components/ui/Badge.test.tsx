import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';
import { getStatusBadgeColor } from './statusBadgeMap';

describe('Badge', () => {
  it('renders the label text (never color-only, per §5.6 accessibility)', () => {
    render(<Badge label="Delivered" color="success" />);
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  it('applies the color-specific class', () => {
    render(<Badge label="At Risk" color="warning" />);
    expect(screen.getByText('At Risk')).toHaveClass('badge-warning');
  });
});

describe('getStatusBadgeColor', () => {
  it('maps Load.status DELIVERED to success', () => {
    expect(getStatusBadgeColor('Load.status', 'DELIVERED')).toBe('success');
  });

  it('maps Invoice.status OVERDUE (computed, never stored) to danger', () => {
    expect(getStatusBadgeColor('Invoice.status', 'OVERDUE')).toBe('danger');
  });

  it('has no entry for Load.riskStatus NORMAL — absence of a badge is the normal state', () => {
    expect(getStatusBadgeColor('Load.riskStatus', 'NORMAL')).toBeUndefined();
  });

  it('returns undefined for an unknown entity/value pair', () => {
    expect(getStatusBadgeColor('Load.status', 'NOT_A_REAL_STATUS')).toBeUndefined();
  });
});
