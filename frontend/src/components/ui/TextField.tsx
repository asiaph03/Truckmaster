import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { FormField } from './FormField';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helperText?: string;
  error?: string;
}

/** UI_UX_DESIGN.md §5.2.5 "Inputs" — text/email/tel/number single-line. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, helperText, error, required, id, className, ...rest },
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
        className={['field-input', error ? 'has-error' : '', className].filter(Boolean).join(' ')}
        required={required}
        {...rest}
      />
    </FormField>
  );
});
