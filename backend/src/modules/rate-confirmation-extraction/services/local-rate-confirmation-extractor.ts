import { Injectable } from '@nestjs/common';
import {
  ExtractedCustomer,
  ExtractedRateConfirmationData,
  ExtractedStop,
  IRateConfirmationExtractor,
  RateConfirmationExtractionOutcome,
} from '../rate-confirmation-extractor.interface';
import { PdfTextExtractorService } from './pdf-text-extractor.service';

const VALID_EQUIPMENT_TYPES = ['DRY_VAN', 'REEFER', 'FLATBED'] as const;
type EquipmentType = (typeof VALID_EQUIPMENT_TYPES)[number];

/**
 * Below this many non-whitespace characters, the extracted text is
 * treated as "no usable text layer" even if pdfjs technically returned
 * something (e.g. a lone watermark or page-number string on an
 * otherwise-scanned page) — not enough to responsibly extract anything
 * from without guessing.
 */
const MIN_USABLE_TEXT_LENGTH = 40;

export const NO_TEXT_LAYER_ERROR_MESSAGE =
  'This PDF does not contain a readable text layer, so it cannot be processed automatically. ' +
  'Scanned or image-only PDFs are not supported — please enter the load details manually, or ' +
  "upload a text-based PDF (e.g. exported directly from the broker's TMS, not a scanned fax/photo).";

const MAX_UNMAPPED_FIELDS = 20;
/** How many lines after a stop-section marker are searched for that stop's fields, before giving up on any field not yet found. */
const STOP_BLOCK_LINE_WINDOW = 10;

/**
 * Rate Confirmation → New Load auto-populate feature — 100% local, no
 * external API, no AI/LLM, no OCR. This is the ONLY extraction provider
 * in the feature (approved replacement for the earlier
 * Anthropic-based extractor, which has been removed entirely).
 *
 * Operates purely on the text layer `PdfTextExtractorService` already
 * pulls out of the PDF locally — never rasterizes pages, never sends
 * document bytes anywhere. A PDF with no usable embedded text layer
 * (scanned/faxed/image-only, or genuinely corrupt) is a hard failure:
 * `extract()` throws with `NO_TEXT_LAYER_ERROR_MESSAGE`, which the
 * worker surfaces as `extractionStatus: FAILED` with that exact message
 * — never a partial/guessed result.
 *
 * Deliberately conservative by construction: every field is only ever
 * populated from a clearly labeled line or an unambiguous pattern match
 * (e.g. "PO #: 12345", "City, ST 12345", a full date+time pair). Nothing
 * is ever inferred, guessed, or defaulted — anything not confidently
 * found is left `null` with a `warnings` entry explaining why, and
 * anything found but not recognized becomes an `unmappedFields` entry
 * rather than being silently discarded. This means the practical
 * extraction quality is inherently lower than an LLM-based approach —
 * that trade-off is intentional (approved requirement: no AI, no
 * guessing) and the human-review UX this feeds into is designed around
 * exactly that: every populated field remains fully editable, and a
 * sparse/mostly-null result is still useful raw material for the user
 * to complete by hand rather than typing everything from scratch.
 */
@Injectable()
export class LocalRateConfirmationExtractor implements IRateConfirmationExtractor {
  constructor(private readonly pdfTextExtractor: PdfTextExtractorService) {}

  async extract(pdfBytes: Buffer, _fileName: string): Promise<RateConfirmationExtractionOutcome> {
    const { text, hasTextLayer } = await this.pdfTextExtractor.extractText(pdfBytes);

    if (!hasTextLayer || text.trim().length < MIN_USABLE_TEXT_LENGTH) {
      throw new Error(NO_TEXT_LAYER_ERROR_MESSAGE);
    }

    return parseRateConfirmationText(text);
  }
}

/**
 * Pure text → structured-data parser, deliberately separated from the
 * PDF/IO layer above (mirrors the previous extractor's
 * IO-call/parse-function split) so it can be unit-tested directly with
 * plain strings, without needing to fabricate PDF bytes for every case.
 */
export function parseRateConfirmationText(text: string): RateConfirmationExtractionOutcome {
  const lines = text.split('\n').map((l) => l.trim());
  const consumed = new Set<number>();

  if (detectMultiLoad(lines)) {
    return { multiLoadDetected: true };
  }

  const warnings: string[] = [];

  const customerRate = extractCustomerRate(lines, consumed, warnings);
  const customerPoNumber = extractLabeledValue(lines, consumed, PO_NUMBER_LABELS);
  const bolNumber = extractLabeledValue(lines, consumed, BOL_NUMBER_LABELS);
  const pickupNumber = extractLabeledValue(lines, consumed, PICKUP_NUMBER_LABELS);
  const customerReferenceNumber = extractLabeledValue(lines, consumed, REFERENCE_NUMBER_LABELS);
  const equipmentType = extractEquipmentType(lines, consumed);
  const customer = extractCustomer(lines, consumed);
  const stops = extractStops(lines, consumed, warnings);

  if (stops.length === 0) {
    warnings.push('No pickup/delivery stops could be confidently identified in this document.');
  }

  const unmappedFields = extractUnmappedFields(lines, consumed);

  const data: ExtractedRateConfirmationData = {
    customer,
    equipmentType,
    customerRate,
    customerPoNumber,
    bolNumber,
    pickupNumber,
    customerReferenceNumber,
    stops,
    warnings,
    unmappedFields,
  };

  return { multiLoadDetected: false, data };
}

// ---------------------------------------------------------------------------
// Multi-load detection
// ---------------------------------------------------------------------------

const LOAD_NUMBER_LABEL =
  /^(?:Load|Order|Booking|Confirmation)\s*(?:#|No\.?|Number)\s*[:\-]?\s*(\S+)/i;

/**
 * Conservative signal, by design: two or more DIFFERENT values under a
 * "Load #"/"Order #"/"Booking #"/"Confirmation #" label anywhere in the
 * document. A single load's own number is never repeated with a
 * different value, so this only fires when the document genuinely
 * appears to describe more than one load — false positives (wrongly
 * rejecting a real single-load document) are far worse here than false
 * negatives, since rejection discards the whole extraction.
 */
function detectMultiLoad(lines: string[]): boolean {
  const values = new Set<string>();
  for (const line of lines) {
    const match = line.match(LOAD_NUMBER_LABEL);
    if (match && match[1]) values.add(match[1].toUpperCase());
  }
  return values.size >= 2;
}

// ---------------------------------------------------------------------------
// Load-level labeled fields
// ---------------------------------------------------------------------------

const PO_NUMBER_LABELS = [/^(?:P\.?O\.?)\s*(?:#|No\.?|Number)?\s*[:\-]\s*(.+)$/i];
const BOL_NUMBER_LABELS = [
  /^(?:BOL|B\/L|Bill\s*of\s*Lading)\s*(?:#|No\.?|Number)?\s*[:\-]\s*(.+)$/i,
];
const PICKUP_NUMBER_LABELS = [/^(?:Pickup|PU)\s*(?:#|No\.?|Number)\s*[:\-]\s*(.+)$/i];
const REFERENCE_NUMBER_LABELS = [
  /^(?:Customer\s*Ref(?:erence)?|Ref(?:erence)?)\s*(?:#|No\.?|Number)?\s*[:\-]\s*(.+)$/i,
];

function extractLabeledValue(
  lines: string[],
  consumed: Set<number>,
  labelPatterns: RegExp[],
): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (consumed.has(i)) continue;
    for (const pattern of labelPatterns) {
      const match = lines[i].match(pattern);
      if (match && match[1] && match[1].trim().length > 0) {
        consumed.add(i);
        return match[1].trim();
      }
    }
  }
  return null;
}

const RATE_LABELS =
  /^(?:Total\s*Rate|Linehaul\s*Rate|Agreed\s*Rate|Rate|Total)\s*[:\-]\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i;

function extractCustomerRate(
  lines: string[],
  consumed: Set<number>,
  warnings: string[],
): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (consumed.has(i)) continue;
    const match = lines[i].match(RATE_LABELS);
    if (match && match[1]) {
      const normalized = Number(match[1].replace(/,/g, ''));
      if (Number.isNaN(normalized)) {
        warnings.push(`Rate value "${match[1]}" could not be parsed as a number.`);
        return null;
      }
      consumed.add(i);
      return normalized.toFixed(2);
    }
  }
  return null;
}

const EQUIPMENT_PATTERNS: { pattern: RegExp; type: EquipmentType }[] = [
  { pattern: /\bREEFER\b|\bREFRIGERATED\b/i, type: 'REEFER' },
  { pattern: /\bFLAT\s*BED\b/i, type: 'FLATBED' },
  { pattern: /\bDRY\s*VAN\b/i, type: 'DRY_VAN' },
];

function extractEquipmentType(lines: string[], consumed: Set<number>): EquipmentType | null {
  const equipmentLabelLine = lines.findIndex(
    (line, i) => !consumed.has(i) && /^(?:Equipment|Trailer\s*Type)\s*[:\-]/i.test(line),
  );
  const searchLines =
    equipmentLabelLine >= 0
      ? [lines[equipmentLabelLine]]
      : lines.filter((_, i) => !consumed.has(i));

  const matches = EQUIPMENT_PATTERNS.filter(({ pattern }) =>
    searchLines.some((line) => pattern.test(line)),
  );
  if (matches.length !== 1) return null; // none found, or ambiguous (more than one equipment keyword present)

  if (equipmentLabelLine >= 0) consumed.add(equipmentLabelLine);
  return matches[0].type;
}

// ---------------------------------------------------------------------------
// Customer (paying party — Bill To / Broker / Customer)
// ---------------------------------------------------------------------------

/** Same whole-line-or-colon-content anchoring as STOP_MARKERS below, for the same reason — an unanchored match would misfire on an ordinary company name like "Customer Solutions LLC" or "Broker Services Inc". */
const CUSTOMER_LABEL = /^(?:Bill\s*To|Broker|Customer)(?:\s*[:\-]\s*(.*)|\s*)$/i;

function extractCustomer(lines: string[], consumed: Set<number>): ExtractedCustomer | null {
  let labelIndex = -1;
  let inlineName = '';
  for (let i = 0; i < lines.length; i += 1) {
    if (consumed.has(i)) continue;
    const match = lines[i].match(CUSTOMER_LABEL);
    if (match) {
      labelIndex = i;
      inlineName = match[1].trim();
      break;
    }
  }
  if (labelIndex === -1) return null;

  consumed.add(labelIndex);

  let extractedName = inlineName;
  let searchStart = labelIndex + 1;
  if (!extractedName) {
    // Label was on its own line — the company name is the next non-empty line.
    for (let i = labelIndex + 1; i < lines.length; i += 1) {
      if (lines[i].length === 0) continue;
      if (isAnyStopOrSectionMarker(lines[i])) break;
      extractedName = lines[i];
      consumed.add(i);
      searchStart = i + 1;
      break;
    }
  }
  if (!extractedName) return null;

  let billingAddressLine1: string | null = null;
  let billingCity: string | null = null;
  let billingState: string | null = null;
  let billingZip: string | null = null;
  let primaryContactName: string | null = null;
  let primaryContactPhone: string | null = null;

  for (
    let i = searchStart;
    i < Math.min(searchStart + STOP_BLOCK_LINE_WINDOW, lines.length);
    i += 1
  ) {
    if (consumed.has(i) || lines[i].length === 0) continue;
    if (isAnyStopOrSectionMarker(lines[i])) break;

    if (!billingAddressLine1) {
      const addr = lines[i].match(STREET_ADDRESS_PATTERN);
      if (addr) {
        billingAddressLine1 = lines[i];
        consumed.add(i);
        continue;
      }
    }
    if (!billingCity) {
      const cityStateZip = lines[i].match(CITY_STATE_ZIP_PATTERN);
      if (cityStateZip) {
        billingCity = cityStateZip[1].trim();
        billingState = cityStateZip[2];
        billingZip = cityStateZip[3];
        consumed.add(i);
        continue;
      }
    }
    if (!primaryContactName) {
      const contact = lines[i].match(CONTACT_NAME_PATTERN);
      if (contact) {
        primaryContactName = contact[1].trim();
        consumed.add(i);
        continue;
      }
    }
    if (!primaryContactPhone) {
      const phone = lines[i].match(PHONE_PATTERN);
      if (phone) {
        primaryContactPhone = phone[1];
        consumed.add(i);
      }
    }
  }

  return {
    extractedName,
    billingAddressLine1,
    billingCity,
    billingState,
    billingZip,
    primaryContactName,
    // Email is never reliably distinguishable from other free text via
    // regex alone without more false positives than it's worth here —
    // left null rather than risking a wrong guess; the user can fill it
    // in manually in the Create Customer flow.
    primaryContactEmail: null,
    primaryContactPhone,
  };
}

// ---------------------------------------------------------------------------
// Stops (ordered, PICKUP/DELIVERY)
// ---------------------------------------------------------------------------

/**
 * Whole-line-anchored by design: the marker word(s) must be either the
 * ENTIRE line (a bare section header, e.g. "PICKUP" or "PICKUP #1" on
 * its own line) or immediately followed by a colon/dash (e.g. "SHIPPER:
 * Acme Co"). A looser "starts with this word" match would misfire on a
 * perfectly ordinary company name like "Shipper One Inc" or "Consignee
 * Two LLC" — both real strings this parser must NOT treat as a second,
 * bogus stop marker (caught by a real test failure during development).
 */
const STOP_MARKERS: { pattern: RegExp; stopType: 'PICKUP' | 'DELIVERY' }[] = [
  {
    pattern:
      /^(?:PICK\s*UP|PICKUP|SHIPPER|SHIP\s*FROM|ORIGIN)(?:\s*#\s*\d+)?(?:\s*[:\-]\s*(.*)|\s*)$/i,
    stopType: 'PICKUP',
  },
  {
    pattern:
      /^(?:DELIVERY|DELIVER\s*TO|CONSIGNEE|SHIP\s*TO|DESTINATION|DROP)(?:\s*#\s*\d+)?(?:\s*[:\-]\s*(.*)|\s*)$/i,
    stopType: 'DELIVERY',
  },
];

/** Additional (non-stop) section labels that also end a customer/stop field-scan window. Less prone to the "matches part of a company name" problem, so left `\b`-anchored rather than whole-line. */
const OTHER_SECTION_LABELS = /^(?:PO\s*#|BOL|Equipment|Rate)\b/i;

const STREET_ADDRESS_PATTERN = /^\d+\s+[A-Za-z0-9][\w\s.,#'-]*$/;
const CITY_STATE_ZIP_PATTERN = /^([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/;
const CONTACT_NAME_PATTERN = /^(?:Contact|Attn|Attention)\s*[:\-]\s*(.+)$/i;
const PHONE_PATTERN = /(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})/;
const APPOINTMENT_DATETIME_PATTERN =
  /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:@|,)?\s*(\d{1,2}:\d{2})\s*(AM|PM)?/i;
const AMBIGUOUS_APPOINTMENT_PATTERN = /\bFCFS\b|\bASAP\b|\bANYTIME\b|\bOPEN\b/i;
const APPOINTMENT_LABEL = /^(?:Appt|Appointment|Date|Time)\b/i;

interface StopMarkerHit {
  lineIndex: number;
  stopType: 'PICKUP' | 'DELIVERY';
  inlineText: string;
}

function findStopMarkers(lines: string[], consumed: Set<number>): StopMarkerHit[] {
  const hits: StopMarkerHit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (consumed.has(i) || lines[i].length === 0) continue;
    for (const { pattern, stopType } of STOP_MARKERS) {
      const match = lines[i].match(pattern);
      if (match) {
        hits.push({ lineIndex: i, stopType, inlineText: match[1]?.trim() ?? '' });
        break;
      }
    }
  }
  return hits;
}

function extractStops(lines: string[], consumed: Set<number>, warnings: string[]): ExtractedStop[] {
  const markers = findStopMarkers(lines, consumed);
  const stops: ExtractedStop[] = [];

  markers.forEach((marker, markerIndex) => {
    consumed.add(marker.lineIndex);
    const blockEnd = Math.min(
      markerIndex + 1 < markers.length ? markers[markerIndex + 1].lineIndex : lines.length,
      marker.lineIndex + 1 + STOP_BLOCK_LINE_WINDOW,
    );

    const stopLabel = `Stop ${markerIndex + 1} (${marker.stopType})`;
    let companyName: string | null = marker.inlineText || null;
    let addressLine1: string | null = null;
    let city: string | null = null;
    let state: string | null = null;
    let zip: string | null = null;
    let contactName: string | null = null;
    let contactPhone: string | null = null;
    let appointmentDatetime: string | null = null;
    let appointmentAmbiguous = false;

    for (let i = marker.lineIndex + 1; i < blockEnd; i += 1) {
      if (consumed.has(i) || lines[i].length === 0) continue;
      const line = lines[i];
      if (isAnyStopOrSectionMarker(line)) break;

      if (!companyName && !isStructuredLine(line)) {
        companyName = line;
        consumed.add(i);
        continue;
      }
      if (!addressLine1 && STREET_ADDRESS_PATTERN.test(line)) {
        addressLine1 = line;
        consumed.add(i);
        continue;
      }
      if (!city) {
        const match = line.match(CITY_STATE_ZIP_PATTERN);
        if (match) {
          city = match[1].trim();
          state = match[2];
          zip = match[3];
          consumed.add(i);
          continue;
        }
      }
      if (!contactName) {
        const match = line.match(CONTACT_NAME_PATTERN);
        if (match) {
          contactName = match[1].trim();
          consumed.add(i);
          continue;
        }
      }
      if (!contactPhone) {
        const match = line.match(PHONE_PATTERN);
        if (match) {
          contactPhone = match[1];
          consumed.add(i);
          continue;
        }
      }
      if (!appointmentDatetime && !appointmentAmbiguous) {
        const match = line.match(APPOINTMENT_DATETIME_PATTERN);
        if (match && match[2]) {
          appointmentDatetime = toNaiveIsoDatetime(match[1], match[2], match[3]);
          consumed.add(i);
          continue;
        }
        if (APPOINTMENT_LABEL.test(line) && AMBIGUOUS_APPOINTMENT_PATTERN.test(line)) {
          appointmentAmbiguous = true;
          consumed.add(i);
        }
      }
    }

    if (!companyName) warnings.push(`${stopLabel}: company name not found.`);
    if (!addressLine1) warnings.push(`${stopLabel}: address not found.`);
    if (!city) warnings.push(`${stopLabel}: city/state/zip not found.`);
    if (appointmentAmbiguous) {
      warnings.push(
        `${stopLabel}: appointment date/time was ambiguous (e.g. FCFS/ASAP/a time window) — left blank rather than guessed.`,
      );
    } else if (!appointmentDatetime) {
      warnings.push(`${stopLabel}: appointment date/time not found.`);
    }

    stops.push({
      stopType: marker.stopType,
      companyName,
      addressLine1,
      city,
      state,
      zip,
      contactName,
      contactPhone,
      appointmentDatetime,
    });
  });

  return stops;
}

function isAnyStopOrSectionMarker(line: string): boolean {
  return STOP_MARKERS.some(({ pattern }) => pattern.test(line)) || OTHER_SECTION_LABELS.test(line);
}

function isStructuredLine(line: string): boolean {
  return (
    STREET_ADDRESS_PATTERN.test(line) ||
    CITY_STATE_ZIP_PATTERN.test(line) ||
    CONTACT_NAME_PATTERN.test(line) ||
    PHONE_PATTERN.test(line) ||
    APPOINTMENT_LABEL.test(line)
  );
}

/** Naive local "YYYY-MM-DDTHH:mm", matching the DatePicker's own output format. Never guesses a missing year (2-digit years are assumed 2000+, matching how these documents always write them). */
function toNaiveIsoDatetime(datePart: string, timePart: string, meridiem?: string): string | null {
  const dateMatch = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  const timeMatch = timePart.match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;

  const [, monthStr, dayStr, yearStr] = dateMatch;
  const [, hourStr, minuteStr] = timeMatch;

  const year = yearStr.length === 2 ? 2000 + Number(yearStr) : Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  let hour = Number(hourStr);
  const minute = Number(minuteStr);

  if (meridiem) {
    const upper = meridiem.toUpperCase();
    if (upper === 'PM' && hour < 12) hour += 12;
    if (upper === 'AM' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || month > 12 || day > 31) return null;

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

// ---------------------------------------------------------------------------
// Unmapped fields — anything clearly "Label: value" that wasn't consumed above
// ---------------------------------------------------------------------------

const GENERIC_LABEL_VALUE_LINE = /^([A-Za-z][A-Za-z0-9 /#.']{1,40}):\s*(.+)$/;

function extractUnmappedFields(
  lines: string[],
  consumed: Set<number>,
): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  for (let i = 0; i < lines.length && fields.length < MAX_UNMAPPED_FIELDS; i += 1) {
    if (consumed.has(i)) continue;
    const match = lines[i].match(GENERIC_LABEL_VALUE_LINE);
    if (match && match[2].trim().length > 0) {
      fields.push({ label: match[1].trim(), value: match[2].trim() });
      consumed.add(i);
    }
  }
  return fields;
}
