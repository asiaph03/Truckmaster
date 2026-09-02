import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AnthropicRateConfirmationExtractor,
  MISSING_ANTHROPIC_API_KEY_ERROR_MESSAGE,
  parseExtractionToolInput,
} from './anthropic-rate-confirmation-extractor';
import { PdfTextExtractionResult } from './pdf-text-extractor.service';
import { ExtractedRateConfirmationData } from '../rate-confirmation-extractor.interface';

function expectData(
  outcome: ReturnType<typeof parseExtractionToolInput>,
): ExtractedRateConfirmationData {
  if (outcome.multiLoadDetected) throw new Error('Expected multiLoadDetected: false');
  return outcome.data;
}

describe('parseExtractionToolInput — defensive parsing of the Anthropic tool-use result', () => {
  it('parses a normal text-layer Rate Confirmation — customer, equipment, rate, pickup + delivery, appointment datetimes', () => {
    const outcome = parseExtractionToolInput({
      multiLoadDetected: false,
      customer: { extractedName: 'Basciani Express' },
      equipmentType: 'REEFER',
      customerRate: '950.00',
      customerPoNumber: '120-25370',
      bolNumber: null,
      pickupNumber: null,
      customerReferenceNumber: null,
      stops: [
        {
          stopType: 'PICKUP',
          companyName: 'I Love Produce',
          addressLine1: '15 Commerce Blvd',
          city: 'WEST GROVE',
          state: 'PA',
          zip: '19390',
          contactName: 'Eric Frasse',
          contactPhone: '(610) 212-1201',
          appointmentDatetime: '2026-09-02T08:00',
        },
        {
          stopType: 'DELIVERY',
          companyName: 'Jetro % Americold',
          addressLine1: '501 Kentile Rd',
          city: 'SOUTH PLAINFIELD',
          state: 'NJ',
          zip: '07080',
          contactName: 'Receiving',
          contactPhone: '(908) 756-6242',
          appointmentDatetime: '2026-09-02T14:00',
        },
      ],
      warnings: [],
      unmappedFields: [
        { label: 'Load Number', value: '17278' },
        { label: 'Weight', value: '42,365' },
        { label: 'Commodity', value: 'Truckload of Produce' },
        { label: 'Special Instructions', value: 'reefer pre cooled to 32 degrees' },
      ],
    });

    const data = expectData(outcome);
    // customer extraction
    expect(data.customer?.extractedName).toBe('Basciani Express');
    // equipment extraction
    expect(data.equipmentType).toBe('REEFER');
    // rate extraction
    expect(data.customerRate).toBe('950.00');
    // pickup + delivery extraction, in order
    expect(data.stops).toHaveLength(2);
    expect(data.stops[0].stopType).toBe('PICKUP');
    expect(data.stops[0].companyName).toBe('I Love Produce');
    expect(data.stops[1].stopType).toBe('DELIVERY');
    expect(data.stops[1].companyName).toBe('Jetro % Americold');
    // appointment datetime extraction
    expect(data.stops[0].appointmentDatetime).toBe('2026-09-02T08:00');
    expect(data.stops[1].appointmentDatetime).toBe('2026-09-02T14:00');
    // unmapped fields (no dedicated interface field for these)
    expect(data.unmappedFields).toContainEqual({ label: 'Load Number', value: '17278' });
  });

  it('preserves stop order — pickup first, delivery second', () => {
    const outcome = parseExtractionToolInput({
      multiLoadDetected: false,
      stops: [
        { stopType: 'PICKUP', companyName: 'Shipper A' },
        { stopType: 'DELIVERY', companyName: 'Consignee A' },
      ],
      warnings: [],
      unmappedFields: [],
    });
    expect(expectData(outcome).stops.map((s) => s.stopType)).toEqual(['PICKUP', 'DELIVERY']);
  });

  it('preserves warnings and partial extraction — unreadable fields stay null, never guessed', () => {
    const outcome = parseExtractionToolInput({
      multiLoadDetected: false,
      stops: [
        {
          stopType: 'DELIVERY',
          companyName: 'Consignee A',
          addressLine1: null,
          appointmentDatetime: null,
        },
      ],
      warnings: ['Stop 1 (DELIVERY): address not found.'],
      unmappedFields: [],
    });
    const data = expectData(outcome);
    expect(data.stops[0].addressLine1).toBeNull();
    expect(data.stops[0].appointmentDatetime).toBeNull();
    expect(data.warnings).toEqual(['Stop 1 (DELIVERY): address not found.']);
  });

  it('throws on malformed model output — non-object', () => {
    expect(() => parseExtractionToolInput('not an object')).toThrow(
      'Extraction tool input was not an object.',
    );
  });

  it('throws on malformed model output — missing stops array', () => {
    expect(() => parseExtractionToolInput({ multiLoadDetected: false })).toThrow(
      'Extraction tool input is missing a stops array.',
    );
  });

  it('throws on malformed model output — invalid stopType', () => {
    expect(() =>
      parseExtractionToolInput({
        multiLoadDetected: false,
        stops: [{ stopType: 'ORIGIN' }],
        warnings: [],
        unmappedFields: [],
      }),
    ).toThrow('stops[0].stopType was not PICKUP/DELIVERY');
  });

  it('detects a multi-load document and returns no stops/fields', () => {
    const outcome = parseExtractionToolInput({
      multiLoadDetected: true,
      stops: [{ stopType: 'PICKUP', companyName: 'Should be discarded' }],
    });
    expect(outcome).toEqual({ multiLoadDetected: true });
  });
});

describe('AnthropicRateConfirmationExtractor — never creates a Load or Customer', () => {
  it('has no import of LoadService, CustomerService, or any Load/Customer creation API', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'anthropic-rate-confirmation-extractor.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/LoadService/);
    expect(source).not.toMatch(/CustomerService/);
    expect(source).not.toMatch(
      /loadsApi|customersApi|prisma\.load\.create|prisma\.customer\.create/i,
    );
  });
});

describe('AnthropicRateConfirmationExtractor — missing ANTHROPIC_API_KEY does not crash the app', () => {
  it('does not throw when constructed with no API key configured', () => {
    expect(
      () =>
        new AnthropicRateConfirmationExtractor(
          { get: () => ({ apiKey: '', model: 'claude-sonnet-5' }) } as never,
          { extractText: jest.fn() } as never,
        ),
    ).not.toThrow();
  });

  it('extract() throws MISSING_ANTHROPIC_API_KEY_ERROR_MESSAGE, and never calls the PDF text extractor, when no key is configured', async () => {
    const extractTextMock = jest.fn();
    const extractor = new AnthropicRateConfirmationExtractor(
      { get: () => ({ apiKey: '', model: 'claude-sonnet-5' }) } as never,
      { extractText: extractTextMock } as never,
    );

    await expect(extractor.extract(Buffer.from('x'), 'f.pdf')).rejects.toThrow(
      MISSING_ANTHROPIC_API_KEY_ERROR_MESSAGE,
    );
    expect(extractTextMock).not.toHaveBeenCalled();
  });
});

describe('AnthropicRateConfirmationExtractor.extract — request shape (mocked client, no real API call)', () => {
  function buildExtractor(
    createImpl: (...args: unknown[]) => unknown,
    pdfTextResult: PdfTextExtractionResult,
  ) {
    const createMock = jest.fn().mockImplementation(createImpl);
    const extractor = new AnthropicRateConfirmationExtractor(
      { get: () => ({ apiKey: 'test-key', model: 'claude-sonnet-5' }) } as never,
      { extractText: jest.fn().mockResolvedValue(pdfTextResult) } as never,
    );
    // Replace the real Anthropic client instance with a stub — never touches the network.
    (extractor as unknown as { client: { messages: { create: typeof createMock } } }).client = {
      messages: { create: createMock },
    };
    return { extractor, createMock };
  }

  const CLEAN_TOOL_RESULT = {
    multiLoadDetected: false,
    stops: [],
    warnings: [],
    unmappedFields: [],
  };

  function toolUseResponse(input: unknown) {
    return { content: [{ type: 'tool_use', name: 'record_rate_confirmation_extraction', input }] };
  }

  it('sends extracted text (not the raw PDF) when a text layer is present', async () => {
    const { extractor, createMock } = buildExtractor(() => toolUseResponse(CLEAN_TOOL_RESULT), {
      text: 'RATE CONFIRMATION text',
      pageCount: 1,
      hasTextLayer: true,
    });

    await extractor.extract(Buffer.from('%PDF-1.4'), 'ratecon.pdf');

    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-5');
    expect(call.messages[0].content).toHaveLength(1);
    expect(call.messages[0].content[0].type).toBe('text');
    expect(call.messages[0].content[0].text).toContain('RATE CONFIRMATION text');
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'record_rate_confirmation_extraction' });
  });

  it('sends the raw PDF as a document content block when there is no text layer (scanned/image-only)', async () => {
    const { extractor, createMock } = buildExtractor(() => toolUseResponse(CLEAN_TOOL_RESULT), {
      text: '',
      pageCount: 1,
      hasTextLayer: false,
    });

    await extractor.extract(Buffer.from('%PDF-1.4 scanned'), 'scanned.pdf');

    const call = createMock.mock.calls[0][0];
    const contentTypes = call.messages[0].content.map((c: { type: string }) => c.type);
    expect(contentTypes).toEqual(['document', 'text']);
    const docContent = call.messages[0].content[0];
    expect(docContent.source.type).toBe('base64');
    expect(docContent.source.media_type).toBe('application/pdf');
    expect(docContent.source.data.length).toBeGreaterThan(0);
  });

  it('throws when the response has no tool_use block', async () => {
    const { extractor } = buildExtractor(
      () => ({ content: [{ type: 'text', text: 'no tool call' }] }),
      {
        text: 'x',
        pageCount: 1,
        hasTextLayer: true,
      },
    );

    await expect(extractor.extract(Buffer.from('x'), 'f.pdf')).rejects.toThrow(
      'Anthropic response did not include a structured tool-use result.',
    );
  });

  it('surfaces an Anthropic API failure (e.g. network/rate-limit error) rather than swallowing it', async () => {
    const { extractor } = buildExtractor(
      () => {
        throw new Error('Anthropic API request failed with status 529.');
      },
      { text: 'x', pageCount: 1, hasTextLayer: true },
    );

    await expect(extractor.extract(Buffer.from('x'), 'f.pdf')).rejects.toThrow(
      'Anthropic API request failed with status 529.',
    );
  });
});
