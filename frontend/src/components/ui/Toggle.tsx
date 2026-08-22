import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import './Toggle.css';

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
}

export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(function Toggle(
  { label, id, className, ...rest },
  ref,
) {
  const fieldId = id ?? `toggle-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <label className={['toggle', className].filter(Boolean).join(' ')} htmlFor={fieldId}>
      <input ref={ref} id={fieldId} type="checkbox" className="toggle-input" {...rest} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </label>
  );
});
