/**
 * Rate Confirmation → New Load auto-populate feature — approved canonical
 * schema. One flat, order-preserving `stops` array (never split into
 * pickupStops/deliveryStops — that shape cannot represent a
 * PICKUP→DELIVERY→PICKUP→DELIVERY document, only "all pickups then all
 * deliveries"). Every field mirrors an actual existing field name from
 * `LoadStopInputDto`/`CreateLoadDto` (backend) and
 * `LoadStopInput`/`CreateLoadRequest` (frontend) — nothing invented.
 *
 * This is the STRUCTURED, UNTRUSTED output of a 100% local, no-AI,
 * regex/heuristic-based extraction pass (see LocalRateConfirmationExtractor
 * — no LLM, no OCR, no external API is used anywhere in this feature). It
 * is never written directly to the database and never bypasses
 * `CreateLoadDto`/`LoadService.createDirect`'s existing validation — it
 * only ever pre-fills client-side New Load form state for human review.
 */
export interface ExtractedStop {
  stopType: 'PICKUP' | 'DELIVERY';
  companyName: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contactName: string | null;
  contactPhone: string | null;
  /** Naive local "YYYY-MM-DDTHH:mm", matching the DatePicker's own output format — null if date-only/ambiguous, never guessed. */
  appointmentDatetime: string | null;
}

/**
 * Raw extracted text only — never a resolved Customer.id. Customer
 * matching happens client-side against the org's own already-loaded
 * customer list (see LoadCreatePage). Fields beyond `extractedName`
 * exist only to prefill the EXISTING Customer-creation form/modal when
 * no match is found and the user explicitly clicks "Create Customer" —
 * they mirror CreateCustomerDto's actual field set exactly (nothing
 * invented: no MC/DOT number field here since Customer has none). Any of
 * these may be null if not confidently found; the user must fill in
 * whatever's missing before Customer creation can succeed, since
 * CreateCustomerDto requires all of them.
 */
export interface ExtractedCustomer {
  extractedName: string;
  billingAddressLine1: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
}

export interface ExtractedRateConfirmationData {
  customer: ExtractedCustomer | null;
  equipmentType: 'DRY_VAN' | 'REEFER' | 'FLATBED' | null;
  /** Normalized decimal string, e.g. "2500.00" — handles "$2,500", "$2500.00", "2500", etc. */
  customerRate: string | null;
  customerPoNumber: string | null;
  bolNumber: string | null;
  pickupNumber: string | null;
  customerReferenceNumber: string | null;
  /** Ordered exactly as the stops appear in the document — see the module doc comment above. */
  stops: ExtractedStop[];
  /** May reference a specific stop, e.g. "Stop 2 (DELIVERY): contact phone not found." */
  warnings: string[];
  /** Rate-confirmation info with no destination field on this form — never silently discarded. */
  unmappedFields: { label: string; value: string }[];
}

/**
 * Set when the document appears to contain multiple independent loads
 * rather than multiple stops for one load — a distinct outcome from a
 * normal extraction, deliberately not just "an ExtractedRateConfirmationData
 * with lots of warnings." When true, the caller must reject the whole
 * extraction (no stops/fields returned, no merging of the loads) rather
 * than guessing which load to keep.
 */
export type RateConfirmationExtractionOutcome =
  { multiLoadDetected: true } | { multiLoadDetected: false; data: ExtractedRateConfirmationData };

/**
 * Replaceable extraction provider — mirrors IMalwareScanner's exact
 * pattern (Architecture Decision 10 precedent): the interface is the
 * locked deliverable, the concrete provider (LocalRateConfirmationExtractor
 * today — a 100% local, no-AI, no-external-API implementation) is a
 * swappable implementation detail that never leaks into
 * RateConfirmationExtractionService or any call site.
 */
export interface IRateConfirmationExtractor {
  /**
   * @param pdfBytes the raw, already-malware-scanned-CLEAN PDF bytes.
   * @param fileName original file name, for context/logging only (never logged in full — see the service's own logging convention).
   */
  extract(pdfBytes: Buffer, fileName: string): Promise<RateConfirmationExtractionOutcome>;
}

export const RATE_CONFIRMATION_EXTRACTOR = 'RATE_CONFIRMATION_EXTRACTOR';
