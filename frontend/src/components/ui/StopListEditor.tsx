import { Plus, Trash2 } from 'lucide-react';
import { Button } from './Button';
import { Select } from './Select';
import { TextField } from './TextField';
import { DatePicker } from './DatePicker';
import { Textarea } from './Textarea';
import './StopListEditor.css';

export type StopFormStopType = 'PICKUP' | 'DELIVERY' | 'OTHER';

export interface StopFormValue {
  stopType: StopFormStopType;
  city: string;
  state: string;
  zip: string;
  // 'full' mode only (Direct Booking) — matches LoadStopInputDto.
  companyName?: string;
  addressLine1?: string;
  appointmentDatetime?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
  // 'lane' mode only (Quote) — matches QuoteStopInputDto.
  appointmentNotes?: string;
}

const STOP_TYPE_OPTIONS_LANE = [
  { value: 'PICKUP', label: 'Pickup' },
  { value: 'DELIVERY', label: 'Delivery' },
];
const STOP_TYPE_OPTIONS_FULL = [...STOP_TYPE_OPTIONS_LANE, { value: 'OTHER', label: 'Other' }];

function emptyStop(mode: 'lane' | 'full', stopType: StopFormStopType): StopFormValue {
  return mode === 'lane'
    ? { stopType, city: '', state: '', zip: '' }
    : { stopType, city: '', state: '', zip: '', companyName: '', addressLine1: '' };
}

/**
 * `sequence` is derived from array position (index + 1), not user-
 * editable — matches how both `CreateLoadDto`/`CreateQuoteDto` treat it
 * (server doesn't care about gaps, only relative order).
 *
 * Two modes: 'lane' (city/state/zip only — `QuoteStopInputDto`, no
 * street address) and 'full' (+ address line, appointment datetime,
 * contact — `LoadStopInputDto`). One component, not two, since the
 * fields are a strict superset and the interaction pattern (add/
 * remove/reorder-by-index) is identical.
 */
export function StopListEditor({
  mode,
  stops,
  onChange,
  error,
  allowAddRemove = true,
}: {
  mode: 'lane' | 'full';
  stops: StopFormValue[];
  // Widened to accept an updater function — every call site passes a
  // `useState` setter directly (`onChange={setStops}`), which already
  // supports this at runtime. Using the updater form here (rather than
  // computing off the `stops` prop) avoids a stale-closure clobber when
  // two mutations land in the same React batch, e.g. Add Pickup and Add
  // Delivery clicked back to back: both handlers would otherwise close
  // over the same pre-update `stops` array and the second call would
  // silently overwrite the first's result instead of appending to it.
  onChange: (updater: StopFormValue[] | ((prev: StopFormValue[]) => StopFormValue[])) => void;
  error?: string;
  // Load Detail's Edit Stops action edits existing stops' fields only —
  // it never adds, removes, or reorders a stop (the backend's bulk update
  // matches each item back to an existing row by its current `sequence`
  // and never touches that field). Defaults to true so Create/Quote's
  // existing add/remove behavior is unaffected.
  allowAddRemove?: boolean;
}) {
  const typeOptions = mode === 'lane' ? STOP_TYPE_OPTIONS_LANE : STOP_TYPE_OPTIONS_FULL;

  function updateStop(index: number, patch: Partial<StopFormValue>) {
    onChange((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addStop(stopType: StopFormStopType) {
    onChange((prev) => [...prev, emptyStop(mode, stopType)]);
  }

  function removeStop(index: number) {
    onChange((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="stop-list-editor">
      {stops.map((stop, index) => (
        <div key={index} className="stop-list-row">
          <div className="stop-list-row-header">
            <span className="stop-list-seq">Stop {index + 1}</span>
            <Select
              id={`stop-${index}-type`}
              label="Type"
              options={typeOptions}
              value={stop.stopType}
              onChange={(e) => updateStop(index, { stopType: e.target.value as StopFormStopType })}
            />
            {allowAddRemove ? (
              <Button
                variant="icon"
                type="button"
                aria-label={`Remove stop ${index + 1}`}
                onClick={() => removeStop(index)}
              >
                <Trash2 size={16} strokeWidth={1.5} />
              </Button>
            ) : null}
          </div>

          {mode === 'full' ? (
            <TextField
              id={`stop-${index}-company-name`}
              label="Company Name"
              required
              value={stop.companyName ?? ''}
              onChange={(e) => updateStop(index, { companyName: e.target.value })}
            />
          ) : null}

          {mode === 'full' ? (
            <TextField
              id={`stop-${index}-address-line-1`}
              label="Address Line 1"
              required
              value={stop.addressLine1 ?? ''}
              onChange={(e) => updateStop(index, { addressLine1: e.target.value })}
            />
          ) : null}

          <div className="detail-card-grid">
            <TextField
              id={`stop-${index}-city`}
              label="City"
              required
              value={stop.city}
              onChange={(e) => updateStop(index, { city: e.target.value })}
            />
            <TextField
              id={`stop-${index}-state`}
              label="State"
              required
              value={stop.state}
              onChange={(e) => updateStop(index, { state: e.target.value })}
            />
            <TextField
              id={`stop-${index}-zip`}
              label="ZIP"
              required
              value={stop.zip}
              onChange={(e) => updateStop(index, { zip: e.target.value })}
            />
          </div>

          {mode === 'full' ? (
            <>
              <DatePicker
                id={`stop-${index}-appointment`}
                label="Appointment"
                withTime
                value={stop.appointmentDatetime ?? ''}
                onChange={(e) => updateStop(index, { appointmentDatetime: e.target.value })}
              />
              <div className="detail-card-grid">
                <TextField
                  id={`stop-${index}-contact-name`}
                  label="Contact Name"
                  value={stop.contactName ?? ''}
                  onChange={(e) => updateStop(index, { contactName: e.target.value })}
                />
                <TextField
                  id={`stop-${index}-contact-phone`}
                  label="Contact Phone"
                  value={stop.contactPhone ?? ''}
                  onChange={(e) => updateStop(index, { contactPhone: e.target.value })}
                />
              </div>
              <Textarea
                id={`stop-${index}-notes`}
                label="Notes"
                value={stop.notes ?? ''}
                onChange={(e) => updateStop(index, { notes: e.target.value })}
              />
            </>
          ) : (
            <Textarea
              id={`stop-${index}-appointment-notes`}
              label="Appointment Notes"
              value={stop.appointmentNotes ?? ''}
              onChange={(e) => updateStop(index, { appointmentNotes: e.target.value })}
            />
          )}
        </div>
      ))}

      {error ? <p className="stop-list-error">{error}</p> : null}

      {allowAddRemove ? (
        <div className="stop-list-add-row">
          <Button variant="secondary" size="sm" type="button" onClick={() => addStop('PICKUP')}>
            <Plus size={14} strokeWidth={1.5} /> Add Pickup
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => addStop('DELIVERY')}>
            <Plus size={14} strokeWidth={1.5} /> Add Delivery
          </Button>
        </div>
      ) : null}
    </div>
  );
}
