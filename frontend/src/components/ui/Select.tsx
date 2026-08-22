import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { FormField } from './FormField';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: SelectOption[];
  placeholder?: string;
  helperText?: string;
  error?: string;
}

/** UI_UX_DESIGN.md §5.2.5 "Selects" — same shell as text input + chevron (native <select> for Phase 2). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, placeholder, helperText, error, required, id, className, ...rest },
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
      <select
        ref={ref}
        id={fieldId}
        className={['field-select', error ? 'has-error' : '', className].filter(Boolean).join(' ')}
        required={required}
        defaultValue={rest.defaultValue ?? ''}
        {...rest}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </FormField>
  );
});
