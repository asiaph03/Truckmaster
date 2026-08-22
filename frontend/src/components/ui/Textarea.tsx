import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { FormField } from './FormField';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  helperText?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
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
      <textarea
        ref={ref}
        id={fieldId}
        className={['field-textarea', error ? 'has-error' : '', className]
          .filter(Boolean)
          .join(' ')}
        required={required}
        {...rest}
      />
    </FormField>
  );
});
