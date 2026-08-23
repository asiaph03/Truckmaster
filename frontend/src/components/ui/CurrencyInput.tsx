import { forwardRef, useState } from 'react';
import type { InputHTMLAttributes, FocusEvent } from 'react';
import { FormField } from './FormField';
import './CurrencyInput.css';

export interface CurrencyInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue'
> {
  label: string;
  helperText?: string;
  error?: string;
  /** Decimal string, e.g. "2450.00" — matches the backend's DECIMAL(12,2) convention. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

/**
 * UI_UX_DESIGN.md §5.2.5 "Currency inputs" — right-aligned, `$` prefix,
 * tabular-nums, formatted to 2 decimals on blur so what's displayed
 * always matches the backend's DECIMAL(12,2)/decimal-string convention
 * (Architecture Decision 6).
 */
export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput(
    {
      label,
      helperText,
      error,
      required,
      id,
      className,
      value,
      defaultValue,
      onValueChange,
      onChange,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const [internal, setInternal] = useState(defaultValue ?? '');
    const isControlled = value !== undefined;
    const current = isControlled ? value : internal;
    const fieldId = id ?? `field-${label.replace(/\s+/g, '-').toLowerCase()}`;

    function handleBlur(e: FocusEvent<HTMLInputElement>) {
      const raw = e.target.value.replace(/[^0-9.]/g, '');
      const num = Number(raw);
      const formatted = raw === '' || Number.isNaN(num) ? '' : num.toFixed(2);
      if (!isControlled) setInternal(formatted);
      onValueChange?.(formatted);
      onBlur?.(e);
    }

    // `onChange` (e.g. react-hook-form's `register()`) must be destructured
    // out and composed here, not left in `...rest` — spreading `rest` after
    // this element's own `onChange`/`value` (as JSX prop order requires,
    // since `value` must stay controlled by `current`) would let a
    // caller-supplied `onChange` silently replace this one, freezing the
    // field at its initial value: every keystroke would filter/format
    // correctly in a local variable that never reaches `current`, so
    // nothing ever appears to be typed. Composing here — filter first,
    // sync the DOM node so the caller reads the same filtered value, then
    // forward the event — fixes every existing `register()` call site at
    // once (Load/Quote Customer Rate, Carrier Rate modals, Insurance/Rate
    // Agreement forms) without changing any of their call sites.
    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      const raw = e.target.value.replace(/[^0-9.]/g, '');
      if (!isControlled) setInternal(raw);
      onValueChange?.(raw);
      e.target.value = raw;
      onChange?.(e);
    }

    return (
      <FormField
        label={label}
        htmlFor={fieldId}
        required={required}
        helperText={helperText}
        error={error}
      >
        <div className="currency-input-shell">
          <span className="currency-input-prefix">$</span>
          <input
            ref={ref}
            id={fieldId}
            inputMode="decimal"
            className={[
              'field-input',
              'currency-input',
              'tabular-nums',
              error ? 'has-error' : '',
              className,
            ]
              .filter(Boolean)
              .join(' ')}
            required={required}
            value={current}
            onChange={handleChange}
            onBlur={handleBlur}
            {...rest}
          />
        </div>
      </FormField>
    );
  },
);
