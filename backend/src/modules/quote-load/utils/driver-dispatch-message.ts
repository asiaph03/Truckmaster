/**
 * Driver Dispatch Email feature — the ONE deterministic formatter used
 * for both the preview endpoint and the actual send (no separate
 * preview-vs-send implementations to drift apart — see
 * CarrierSourcingService.previewDriverDispatchEmail/
 * sendDriverDispatchEmail, both of which call this same function).
 * Pure and side-effect-free: no AI, no external calls, no randomness —
 * the exact same input always produces the exact same output. Never
 * hard-codes carrier/driver/phone/truck/trailer/equipment/stops/dates/
 * PO/pickup number/rate/order number/customer — every value comes from
 * the caller's input, sourced from the real Load/Stop/DispatchRecord/
 * Customer/Carrier records. Missing optional values are omitted cleanly
 * — never a "null"/"undefined" string, never a dangling empty line.
 */

import {
  BUSINESS_TIMEZONE,
  wallClockPartsInZone,
} from '../../../common/timezone/business-timezone';

export interface DriverDispatchStopInput {
  stopType: 'PICKUP' | 'DELIVERY' | 'OTHER';
  companyName: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Naive local "YYYY-MM-DDTHH:mm" (or a full ISO string) — same shape DatePicker/appointmentDatetime already use elsewhere in this codebase. */
  appointmentDatetime: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

export interface DriverDispatchMessageInput {
  loadNumber: string;
  carrierLegalName: string;
  customerLegalName: string;
  driverName: string;
  driverPhone: string;
  customerPoNumber: string | null;
  customerRate: string | null;
  stops: DriverDispatchStopInput[];
  /**
   * Raw text currently persisted on the pickup stop's Notes field (see
   * LoadCreatePage.tsx's EXTRACTED_NOTES_FIELDS / buildExtractedNotesBlock
   * — this is the SAME canonical "Label: value" format written there).
   * null/undefined when the stop has no notes at all.
   */
  pickupStopNotes: string | null | undefined;
  /**
   * Load.pickupNumber — the SAME authoritative field already shown as
   * "Pickup #" on the Load Overview tab (OverviewTab.tsx). Load-level,
   * not per-stop, so it's rendered on every PICKUP-type stop block
   * (never on DELIVERY/OTHER). Never substituted with customerPoNumber
   * or customerReferenceNumber — those remain their own separate lines.
   */
  pickupNumber: string | null;
}

export interface DriverDispatchMessage {
  subject: string;
  body: string;
}

const APPROVED_NOTES_LABELS = [
  'Reefer Ref#',
  'Mileage',
  'Commodity',
  'Pickup Weight',
  'Special Instructions',
  'Internal Order#',
  'Invoice Email',
  'Detention Policy',
] as const;
type ApprovedNotesLabel = (typeof APPROVED_NOTES_LABELS)[number];

/**
 * Deterministic, exact-line parsing — NOT fuzzy matching. By the time
 * notes reach this stage they were already written using these exact
 * canonical labels (LoadCreatePage's buildExtractedNotesBlock), one
 * "Label: value" pair per line, so a straight per-line prefix match is
 * both sufficient and the most literal, least-surprising interpretation
 * ("use deterministic parsing only"). Any other line in Notes — a
 * dispatcher's own free-text, or a label not in the approved 8 — is
 * silently ignored here, never leaked into the dispatch email.
 */
export function parseApprovedNotesFields(
  notes: string | null | undefined,
): Record<ApprovedNotesLabel, string | null> {
  const result = Object.fromEntries(APPROVED_NOTES_LABELS.map((l) => [l, null])) as Record<
    ApprovedNotesLabel,
    string | null
  >;
  if (!notes) return result;

  for (const line of notes.split('\n')) {
    for (const label of APPROVED_NOTES_LABELS) {
      const prefix = `${label}: `;
      if (line.startsWith(prefix)) {
        const value = line.slice(prefix.length).trim();
        if (value.length > 0) result[label] = value;
      }
    }
  }
  return result;
}

/**
 * "MM/DD/YY at H:MM AM/PM" — exact format requested. Returns null (never
 * guesses/throws) for an unparseable or missing value.
 *
 * The caller (CarrierSourcingService.resolveDriverDispatchContext) passes
 * an absolute UTC instant (`Stop.appointmentDatetime.toISOString()`), so
 * this must render it in the business timezone explicitly — via the same
 * `wallClockPartsInZone` ICU-backed helper `business-timezone.ts` already
 * uses for every other operational timestamp — never `Date`'s local
 * getters, which would silently depend on the server process's own OS
 * timezone instead of `BUSINESS_TIMEZONE` (America/New_York).
 */
export function formatAppointment(datetime: string | null | undefined): string | null {
  if (!datetime) return null;
  const d = new Date(datetime);
  if (Number.isNaN(d.getTime())) return null;

  const { month, day, year, hour: hour24, minute } = wallClockPartsInZone(d, BUSINESS_TIMEZONE);
  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const yearStr = String(year).slice(-2);
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  let hour = hour24 % 12;
  if (hour === 0) hour = 12;

  return `${monthStr}/${dayStr}/${yearStr} at ${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function contactLine(name: string | null, phone: string | null): string | null {
  if (name && phone) return `Contact: ${name} — ${phone}`;
  if (name) return `Contact: ${name}`;
  if (phone) return `Contact: ${phone}`;
  return null;
}

function cityStateZip(
  city: string | null,
  state: string | null,
  zip: string | null,
): string | null {
  const parts = [city, state, zip].filter((p): p is string => Boolean(p && p.trim().length > 0));
  if (parts.length === 0) return null;
  if (city && (state || zip)) return `${city}, ${[state, zip].filter(Boolean).join(' ')}`;
  return parts.join(' ');
}

function buildStopBlock(
  stop: DriverDispatchStopInput,
  index: number,
  pickupNumber: string | null,
): string {
  const label = stop.stopType === 'OTHER' ? `STOP ${index + 1}` : stop.stopType;
  const lines = [`${label}:`];
  if (stop.companyName) lines.push(stop.companyName);
  if (stop.addressLine1) lines.push(stop.addressLine1);
  const csz = cityStateZip(stop.city, stop.state, stop.zip);
  if (csz) lines.push(csz);
  if (stop.stopType === 'PICKUP' && pickupNumber) lines.push(`Pickup #: ${pickupNumber}`);
  const appt = formatAppointment(stop.appointmentDatetime);
  if (appt) lines.push(`📅 ${appt}`);
  const contact = contactLine(stop.contactName, stop.contactPhone);
  if (contact) lines.push(contact);
  return lines.join('\n');
}

export function buildDriverDispatchMessage(
  input: DriverDispatchMessageInput,
): DriverDispatchMessage {
  const subject = `Dispatch Details — Load #${input.loadNumber}`;
  const notes = parseApprovedNotesFields(input.pickupStopNotes);

  const lines: string[] = [];

  lines.push(`🚛 Carrier: ${input.carrierLegalName}`);
  lines.push(`🔗 Driver/Dispatch: ${input.driverName} — ${input.driverPhone}`);

  // Reefer Ref# and Special Instructions are two distinct approved
  // fields — kept as two separate lines (never merged into one combined
  // value) so the reefer's identifying reference number is never
  // conflated with free-text handling instructions. Values are used
  // verbatim — never paraphrased/rewritten/normalized.
  if (notes['Reefer Ref#']) lines.push(`🔑 Reefer Ref#: ${notes['Reefer Ref#']}`);
  if (notes['Special Instructions']) {
    lines.push(`🔑 Special Instructions: ${notes['Special Instructions']}`);
  }

  // Commodity line — Commodity and Pickup Weight both contribute.
  const commodityParts = [notes.Commodity, notes['Pickup Weight']].filter((v): v is string =>
    Boolean(v),
  );
  if (commodityParts.length > 0) lines.push(`📦 Commodity: ${commodityParts.join(' — ')}`);

  lines.push('');
  for (const [index, stop] of input.stops.entries()) {
    lines.push(buildStopBlock(stop, index, input.pickupNumber));
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();

  const trailer: string[] = [];
  if (input.customerPoNumber) trailer.push(`PO: ${input.customerPoNumber}`);
  if (input.customerRate) trailer.push(`💰 Rate: $${input.customerRate}`);
  if (notes['Internal Order#']) trailer.push(`📋 Order #: ${notes['Internal Order#']}`);
  if (trailer.length > 0) {
    lines.push('');
    lines.push(...trailer);
  }

  // Additional-information section — only Mileage/Invoice Email/
  // Detention Policy land here; everything else already appears above
  // (never duplicated) or has no dedicated line (Commodity/Pickup
  // Weight/Reefer Ref#/Special Instructions/Internal Order# are already
  // folded into the lines above).
  const additional: string[] = [];
  if (notes.Mileage) additional.push(`Mileage: ${notes.Mileage}`);
  if (notes['Invoice Email']) additional.push(`Invoice Email: ${notes['Invoice Email']}`);
  if (notes['Detention Policy']) additional.push(`Detention Policy: ${notes['Detention Policy']}`);
  if (additional.length > 0) {
    lines.push('');
    lines.push(...additional);
  }

  lines.push('');
  lines.push(
    `Important: Call ${input.customerLegalName} to get dispatched before heading to pickup. Daily updates are required until delivery.`,
  );

  return { subject, body: lines.join('\n').trim() };
}
