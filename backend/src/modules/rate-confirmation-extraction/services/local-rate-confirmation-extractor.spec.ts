import {
  LocalRateConfirmationExtractor,
  NO_TEXT_LAYER_ERROR_MESSAGE,
  parseRateConfirmationText,
} from './local-rate-confirmation-extractor';
import { PdfTextExtractorService, PdfTextExtractionResult } from './pdf-text-extractor.service';
import { ExtractedRateConfirmationData } from '../rate-confirmation-extractor.interface';

function expectData(
  outcome: ReturnType<typeof parseRateConfirmationText>,
): ExtractedRateConfirmationData {
  if (outcome.multiLoadDetected) throw new Error('Expected multiLoadDetected: false');
  return outcome.data;
}

describe('parseRateConfirmationText — 100% local, no-AI field/stop extraction', () => {
  it('extracts load-level fields, the customer, and ordered stops from a well-formed document', () => {
    const text = [
      'RATE CONFIRMATION',
      'Load #: RC100234',
      'Bill To:',
      'Acme Freight LLC',
      '500 Commerce St',
      'Dallas, TX 75201',
      'Contact: Jane Doe',
      '(214) 555-0100',
      'PO #: PO-4821',
      'BOL #: BOL-99213',
      'Pickup #: PU-5567',
      'Reference #: REF-771',
      'Equipment: Dry Van',
      'Total Rate: $2,500.00',
      'PICKUP:',
      'Shipper One Inc',
      '100 Dock Rd',
      'Memphis, TN 38103',
      'Contact: Bob Smith',
      '(901) 555-0111',
      'Appt: 03/15/2026 08:00 AM',
      'DELIVERY:',
      'Consignee Two LLC',
      '200 Warehouse Ave',
      'Atlanta, GA 30301',
      'Contact: Carol Jones',
      '(404) 555-0222',
      'Appt: 03/16/2026 14:00',
    ].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.customerPoNumber).toBe('PO-4821');
    expect(data.bolNumber).toBe('BOL-99213');
    expect(data.pickupNumber).toBe('PU-5567');
    expect(data.customerReferenceNumber).toBe('REF-771');
    expect(data.equipmentType).toBe('DRY_VAN');
    expect(data.customerRate).toBe('2500.00');

    expect(data.customer).toEqual(
      expect.objectContaining({
        extractedName: 'Acme Freight LLC',
        billingAddressLine1: '500 Commerce St',
        billingCity: 'Dallas',
        billingState: 'TX',
        billingZip: '75201',
        primaryContactName: 'Jane Doe',
        primaryContactPhone: '(214) 555-0100',
      }),
    );

    expect(data.stops).toEqual([
      {
        stopType: 'PICKUP',
        companyName: 'Shipper One Inc',
        addressLine1: '100 Dock Rd',
        city: 'Memphis',
        state: 'TN',
        zip: '38103',
        contactName: 'Bob Smith',
        contactPhone: '(901) 555-0111',
        appointmentDatetime: '2026-03-15T08:00',
      },
      {
        stopType: 'DELIVERY',
        companyName: 'Consignee Two LLC',
        addressLine1: '200 Warehouse Ave',
        city: 'Atlanta',
        state: 'GA',
        zip: '30301',
        contactName: 'Carol Jones',
        contactPhone: '(404) 555-0222',
        appointmentDatetime: '2026-03-16T14:00',
      },
    ]);

    // Anything with no destination field (e.g. a generic "Load #") is
    // never silently discarded — it shows up as an unmapped field.
    expect(data.unmappedFields).toContainEqual({ label: 'Load #', value: 'RC100234' });
  });

  it('preserves exact stop order — PICKUP, PICKUP, DELIVERY — never grouped by type', () => {
    const text = ['PICKUP: Shipper A', 'PICKUP: Shipper B', 'DELIVERY: Consignee A'].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.stops.map((s) => [s.stopType, s.companyName])).toEqual([
      ['PICKUP', 'Shipper A'],
      ['PICKUP', 'Shipper B'],
      ['DELIVERY', 'Consignee A'],
    ]);
  });

  it('preserves exact interleaved order — PICKUP, DELIVERY, PICKUP, DELIVERY', () => {
    const text = [
      'PICKUP: Shipper A',
      'DELIVERY: Consignee A',
      'PICKUP: Shipper B',
      'DELIVERY: Consignee B',
    ].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.stops.map((s) => s.stopType)).toEqual(['PICKUP', 'DELIVERY', 'PICKUP', 'DELIVERY']);
  });

  it('keeps a stop with unreadable fields in the list — null fields plus a named warning, never dropped, never guessed', () => {
    const text = ['PICKUP: Shipper X', 'DELIVERY:'].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.stops).toHaveLength(2);
    expect(data.stops[1]).toEqual({
      stopType: 'DELIVERY',
      companyName: null,
      addressLine1: null,
      city: null,
      state: null,
      zip: null,
      contactName: null,
      contactPhone: null,
      appointmentDatetime: null,
    });
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Stop 2 (DELIVERY): company name not found.'),
        expect.stringContaining('Stop 2 (DELIVERY): address not found.'),
      ]),
    );
  });

  it('leaves an ambiguous appointment (FCFS) null with a warning rather than guessing', () => {
    const text = ['PICKUP: Shipper X', '100 Dock Rd', 'Memphis, TN 38103', 'Appt: FCFS'].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.stops[0].appointmentDatetime).toBeNull();
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Stop 1 (PICKUP): appointment date/time was ambiguous'),
      ]),
    );
  });

  it('reports no stops found (with a warning) rather than inventing any, when no stop markers exist', () => {
    const text = ['RATE CONFIRMATION', 'Total Rate: $500.00'].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.stops).toEqual([]);
    expect(data.warnings).toContain(
      'No pickup/delivery stops could be confidently identified in this document.',
    );
  });

  it('detects a multi-load document (two different Load # values) and rejects it outright — no stops/fields returned', () => {
    const text = [
      'Load #: AAA111',
      'PICKUP: Shipper A',
      'DELIVERY: Consignee A',
      'Load #: BBB222',
      'PICKUP: Shipper B',
      'DELIVERY: Consignee B',
    ].join('\n');

    const outcome = parseRateConfirmationText(text);

    expect(outcome).toEqual({ multiLoadDetected: true });
  });

  it('does not treat a single, repeated Load # (e.g. on every page) as multi-load', () => {
    const text = [
      'Load #: RC100234',
      'PICKUP: Shipper A',
      'DELIVERY: Consignee A',
      'Load #: RC100234',
    ].join('\n');

    const outcome = parseRateConfirmationText(text);

    expect(outcome.multiLoadDetected).toBe(false);
  });

  it('never selects an equipment type when the text is ambiguous (more than one keyword present)', () => {
    const text = ['Notes: Reefer or Dry Van acceptable', 'PICKUP: Shipper A'].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.equipmentType).toBeNull();
  });

  it('never guesses a rate it cannot parse as a number', () => {
    const text = ['Total Rate: TBD', 'PICKUP: Shipper A'].join('\n');

    const data = expectData(parseRateConfirmationText(text));

    expect(data.customerRate).toBeNull();
  });
});

describe('LocalRateConfirmationExtractor.extract — no text layer (stubbed PdfTextExtractorService)', () => {
  it('throws NO_TEXT_LAYER_ERROR_MESSAGE when the PDF has no text layer', async () => {
    const stub = {
      extractText: jest.fn().mockResolvedValue({
        text: '',
        pageCount: 1,
        hasTextLayer: false,
      } as PdfTextExtractionResult),
    } as unknown as PdfTextExtractorService;

    const extractor = new LocalRateConfirmationExtractor(stub);

    await expect(extractor.extract(Buffer.from('fake'), 'scan.pdf')).rejects.toThrow(
      NO_TEXT_LAYER_ERROR_MESSAGE,
    );
  });

  it('throws NO_TEXT_LAYER_ERROR_MESSAGE when the extracted text is below the usable-length threshold', async () => {
    const stub = {
      extractText: jest.fn().mockResolvedValue({
        text: 'Page 1',
        pageCount: 1,
        hasTextLayer: true,
      } as PdfTextExtractionResult),
    } as unknown as PdfTextExtractorService;

    const extractor = new LocalRateConfirmationExtractor(stub);

    await expect(extractor.extract(Buffer.from('fake'), 'watermark-only.pdf')).rejects.toThrow(
      NO_TEXT_LAYER_ERROR_MESSAGE,
    );
  });
});

// NOTE: True end-to-end tests against real PDF bytes (via pdfkit,
// exercising the actual pdfjs-dist dynamic import) are NOT included in
// this Jest suite. pdfjs-dist's legacy build (`legacy/build/pdf.mjs`) is
// genuine ESM containing `import.meta.url`; Jest's default CommonJS
// runtime (ts-jest, no --experimental-vm-modules) cannot execute that
// syntax at all and fails with "Cannot use 'import.meta' outside a
// module" — a Jest/tooling limitation, not a production issue (Node
// itself, running the compiled app, handles this dynamic import fine).
// Reconfiguring Jest for ESM support project-wide was judged out of
// scope/riskier than warranted for this one dependency. The two required
// real-PDF scenarios (normal text-based PDF; image-only/no-text-layer
// PDF) were instead verified via a standalone ts-node script exercising
// the real PdfTextExtractorService + LocalRateConfirmationExtractor
// pipeline outside Jest — see the verification report for its output.
// PdfTextExtractorService/LocalRateConfirmationExtractor is otherwise
// exercised above via `parseRateConfirmationText` (the pure parsing
// logic) and the stubbed-PdfTextExtractorService tests (the no-text-layer
// error path), which together cover everything Jest is able to run here.
