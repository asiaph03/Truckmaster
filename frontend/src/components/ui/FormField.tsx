import type { ReactNode } from 'react';
import './FormField.css';

export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  helperText?: string;
  error?: string;
  children: ReactNode;
}

/** UI_UX_DESIGN.md §5.2.5 "Inputs" — label above, helper below, `*` for required, error in danger-600. */
export function FormField({
  label,
  htmlFor,
  required,
  helperText,
  error,
  children,
}: FormFieldProps) {
  return (
    <div className="form-field">
      <label className="form-field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="form-field-required">*</span> : null}
      </label>
      {children}
      {error ? (
        <span className="form-field-error">{error}</span>
      ) : helperText ? (
        <span className="form-field-helper">{helperText}</span>
      ) : null}
    </div>
  );
}
