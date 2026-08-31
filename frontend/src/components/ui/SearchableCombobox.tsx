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
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(
    () => options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())),
    [options, query],
  );

  function handleBlur() {
    // Option/manual-entry buttons stop this from firing on their own click
    // (mousedown preventDefault below), so this now only runs for a
    // genuine outside click — safe to close immediately.
    setOpen(false);
  }

  return (
    <FormField label={label} required={required} helperText={helperText} error={error}>
      <div className="combobox" ref={containerRef}>
        <input
          ref={inputRef}
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
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    // Mousedown above kept focus on the input (that's what
                    // stops the race), so release it now that the click has
                    // landed — otherwise a second click on the same,
                    // already-focused input wouldn't re-fire onFocus and
                    // the panel couldn't be reopened to change the pick.
                    inputRef.current?.blur();
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
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onEnterManually();
                  setOpen(false);
                  inputRef.current?.blur();
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
