import { Check } from 'lucide-react';
import './Stepper.css';

export interface StepperStep {
  key: string;
  label: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Index of the step the entity currently sits at (0-based). */
  currentIndex: number;
}

/** UI_UX_DESIGN.md §5.2.5 — Load Detail's lifecycle visualization. */
export function Stepper({ steps, currentIndex }: StepperProps) {
  return (
    <ol className="stepper">
      {steps.map((step, index) => {
        const state =
          index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming';
        return (
          <li key={step.key} className={`stepper-step stepper-${state}`}>
            <span className="stepper-marker">
              {state === 'done' ? <Check size={12} strokeWidth={2} /> : index + 1}
            </span>
            <span className="stepper-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
