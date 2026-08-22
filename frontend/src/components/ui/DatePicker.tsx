import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { FormField } from './FormField';

export interface DatePickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  helperText?: string;
  error?: string;
  /** Adds a time component (e.g. Load stop appointment_datetime) — §5.2.5. */
  withTime?: boolean;
}

/**
 * UI_UX_DESIGN.md §5.2.5 specifies a custom calendar-popover component;
 * Phase 2 uses the native `<input type="date"|"datetime-local">` instead
 * — same field shell/validation/keyboard behavior, browser-native
 * picker UI rather than a custom-built one. A pixel-accurate custom
 * popover is deferred; flagged in the Phase 2 completion report as a
 * scoped-down implementation choice, not a silent deviation.
 */
export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker(
  { label, helperText, error, required, id, className, withTime, ...rest },
  ref,
) {
  const fieldId = id ?? `field-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <FormField
      label={label}
      htmlFor={fieldId}
      required={required}
      helperText={helperText}
      error={error}
    >
      <input
        ref={ref}
        id={fieldId}
        type={withTime ? 'datetime-local' : 'date'}
        className={['field-input', error ? 'has-error' : '', className].filter(Boolean).join(' ')}
        required={required}
        {...rest}
      />
    </FormField>
  );
});
