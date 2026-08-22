import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchableCombobox } from './SearchableCombobox';

const OPTIONS = [
  { value: 'u1', label: 'Alice Admin' },
  { value: 'u2', label: 'Bob Booking' },
];

describe('SearchableCombobox', () => {
  it('filters options as the user types', () => {
    render(
      <SearchableCombobox
        label="Account Owner"
        options={OPTIONS}
        value={null}
        onChange={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText('Search…');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Bob' } });

    expect(screen.getByText('Bob Booking')).toBeInTheDocument();
    expect(screen.queryByText('Alice Admin')).not.toBeInTheDocument();
  });

  it('calls onChange with the selected value', () => {
    const onChange = vi.fn();
    render(
      <SearchableCombobox
        label="Account Owner"
        options={OPTIONS}
        value={null}
        onChange={onChange}
      />,
    );
    fireEvent.focus(screen.getByPlaceholderText('Search…'));
    fireEvent.click(screen.getByText('Alice Admin'));
    expect(onChange).toHaveBeenCalledWith('u1');
  });

  it('always shows a persistent "+ Enter manually" option when provided', () => {
    const onEnterManually = vi.fn();
    render(
      <SearchableCombobox
        label="Location"
        options={OPTIONS}
        value={null}
        onChange={() => {}}
        onEnterManually={onEnterManually}
      />,
    );
    fireEvent.focus(screen.getByPlaceholderText('Search…'));
    fireEvent.click(screen.getByText('+ Enter manually'));
    expect(onEnterManually).toHaveBeenCalledTimes(1);
  });
});
