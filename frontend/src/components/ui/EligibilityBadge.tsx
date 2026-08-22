import { useState } from 'react';
import { Badge } from './Badge';
import './EligibilityBadge.css';

export interface EligibilityBadgeProps {
  eligible: boolean;
  // Nullable — the backend's `ineligibilityReasons` column is `null`
  // until CarrierEligibilityService.recalculate() first runs (a
  // freshly-created carrier has never had that trigger fire).
  reasons: string[] | null;
}

/**
 * Carrier Detail header — Status and Eligibility are two separate,
 * never-merged badges per Workflow 3 §3.8 (UI_UX_DESIGN.md §5.4.6).
 * This renders only the Eligibility half; Status uses the plain `Badge`
 * with the standard `Carrier.status` color mapping. Reads
 * `carrier.ineligibilityReasons` directly from the API — no client-side
 * re-implementation of the 7-condition eligibility logic.
 */
export function EligibilityBadge({ eligible, reasons: reasonsInput }: EligibilityBadgeProps) {
  const [open, setOpen] = useState(false);
  const reasons = reasonsInput ?? [];

  if (eligible) {
    return <Badge label="Eligible" color="success" />;
  }

  return (
    <span
      className="eligibility-badge-wrapper"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="eligibility-badge-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Badge label="Ineligible" color="danger" />
      </button>
      {open && reasons.length > 0 ? (
        <div className="eligibility-badge-popover" role="tooltip">
          <p className="eligibility-badge-popover-title">Why ineligible:</p>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  );
}
