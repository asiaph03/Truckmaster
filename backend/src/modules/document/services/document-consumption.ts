import { DocumentScanStatus } from '@prisma/client';

/**
 * The ONE shared definition of "is this document allowed for consumption"
 * (download, Driver Dispatch Email attachment, Rate Confirmation
 * extraction) — replacing what were previously four independent inline
 * `scanStatus === 'CLEAN'` checks scattered across document.service.ts,
 * carrier-sourcing.service.ts, and rate-confirmation-extraction.service.ts
 * (per the read-only audit).
 *
 * Explicit policy:
 *   CLEAN       -> consumable (the scanner verified it)
 *   SCAN_FAILED -> consumable (the scanner could not reach a verdict —
 *                  treated as usable per the approved operational
 *                  trade-off, the same category of risk already accepted
 *                  by the MALWARE_SCAN_ENABLED=false bypass; never
 *                  rewritten to CLEAN — the real SCAN_FAILED value stays
 *                  persisted for auditability)
 *   INFECTED    -> never consumable
 *   PENDING     -> never consumable (still being scanned)
 *
 * Deliberately NOT used by LoadPodStatusService.recalculatePodStatus —
 * that milestone (feeding invoicing readiness / the Load Closing
 * Checklist) is an explicitly LOCKED (Phase 5 sign-off) CLEAN-only rule,
 * unaffected by this change.
 */
export function isDocumentConsumable(scanStatus: DocumentScanStatus): boolean {
  return scanStatus === 'CLEAN' || scanStatus === 'SCAN_FAILED';
}
