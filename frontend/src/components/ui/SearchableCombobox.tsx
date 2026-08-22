import { useMemo, useRef, useState } from 'react';
import { FormField } from './FormField';
import './SearchableCombobox.css';

export interface ComboboxOption {
  value: string;
  label: string;
}

export interface SearchableComboboxProps {
  label: string;
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  onEnterManually?: () => void;
  placeholder?: string;
  helperText?: string;
  error?: string;
  required?: boolean;
}

/**
 * UI_UX_DESIGN.md §5.2.5 "Searchable combobox" — type-to-filter, with a
 * persistent "+ Enter manually" option at the bottom of the list (the
 * manual-entry fallback from Workflow 5/6's "select from reusable
 * records or manual entry" pattern).
 */
export function SearchableCombobox({
  label,
  options,
  value,
  onChange,
  onEnterManually,
  placeholder = 'Search…',
  helperText,
  error,
  required,
}: SearchableComboboxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(
    () => options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())),
    [options, query],
  );

  function handleBlur() {
    // Delay so a click on a list item registers before the list unmounts.
    setTimeout(() => setOpen(false), 120);
  }

  return (
    <FormField label={label} required={required} helperText={helperText} error={error}>
      <div className="combobox" ref={containerRef}>
        <input
          className={['field-input', error ? 'has-error' : ''].filter(Boolean).join(' ')}
          value={open ? query : (selected?.label ?? '')}
          placeholder={placeholder}
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          onBlur={handleBlur}
          onChange={(e) => setQuery(e.target.value)}
        />
        {open ? (
          <div className="combobox-panel">
            {filtered.length === 0 ? (
              <div className="combobox-empty">No matches</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="combobox-option"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  {opt.label}
                </button>
              ))
            )}
            {onEnterManually ? (
              <button
                type="button"
                className="combobox-option combobox-manual"
                onClick={() => {
                  onEnterManually();
                  setOpen(false);
                }}
              >
                + Enter manually
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </FormField>
  );
}
