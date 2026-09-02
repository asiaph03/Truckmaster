import {
  buildDriverDispatchMessage,
  formatAppointment,
  parseApprovedNotesFields,
  type DriverDispatchMessageInput,
} from './driver-dispatch-message';

const APPROVED_NOTES =
  'Reefer Ref#: MR2\n' +
  'Mileage: 112 Miles\n' +
  'Commodity: Truckload of Produce\n' +
  'Pickup Weight: 42,365 lbs\n' +
  'Special Instructions: reefer pre cooled to 32 degrees\n' +
  'Internal Order#: 56631\n' +
  'Invoice Email: information@bascianiexpress.com\n' +
  'Detention Policy: 2 hours free time; $50.00/hour after; must notify 1 hour before detention begins';

function baseInput(
  overrides: Partial<DriverDispatchMessageInput> = {},
): DriverDispatchMessageInput {
  return {
    loadNumber: '17278',
    carrierLegalName: 'MG CARGO INC',
    customerLegalName: 'Basciani Express',
    driverName: 'Julia',
    driverPhone: '(773) 870-1332',
    customerPoNumber: '120-25370',
    customerRate: '950.00',
    stops: [
      {
        stopType: 'PICKUP',
        companyName: 'I Love Produce',
        addressLine1: '15 Commerce Blvd',
        city: 'West Grove',
        state: 'PA',
        zip: '19390',
        appointmentDatetime: '2026-09-02T08:00',
        contactName: 'Eric Frasse',
        contactPhone: '(610) 212-1201',
      },
      {
        stopType: 'DELIVERY',
        companyName: 'Jetro % Americold',
        addressLine1: '501 Kentile Rd',
        city: 'South Plainfield',
        state: 'NJ',
        zip: '07080',
        appointmentDatetime: '2026-09-02T14:00',
        contactName: null,
        contactPhone: '(908) 756-6242',
      },
    ],
    pickupStopNotes: APPROVED_NOTES,
    ...overrides,
  };
}

describe('formatAppointment — "MM/DD/YY at H:MM AM/PM"', () => {
  it('formats a morning time', () => {
    expect(formatAppointment('2026-09-02T08:00')).toBe('09/02/26 at 8:00 AM');
  });
  it('formats an afternoon time (24h -> 12h conversion)', () => {
    expect(formatAppointment('2026-09-02T14:00')).toBe('09/02/26 at 2:00 PM');
  });
  it('formats midnight as 12 AM and noon as 12 PM', () => {
    expect(formatAppointment('2026-01-01T00:00')).toBe('01/01/26 at 12:00 AM');
    expect(formatAppointment('2026-01-01T12:00')).toBe('01/01/26 at 12:00 PM');
  });
  it('returns null for missing or unparseable input', () => {
    expect(formatAppointment(null)).toBeNull();
    expect(formatAppointment(undefined)).toBeNull();
    expect(formatAppointment('not a date')).toBeNull();
  });
});

describe('parseApprovedNotesFields — deterministic exact-line parsing', () => {
  it('extracts all 8 approved fields from canonical "Label: value" lines', () => {
    const parsed = parseApprovedNotesFields(APPROVED_NOTES);
    expect(parsed).toEqual({
      'Reefer Ref#': 'MR2',
      Mileage: '112 Miles',
      Commodity: 'Truckload of Produce',
      'Pickup Weight': '42,365 lbs',
      'Special Instructions': 'reefer pre cooled to 32 degrees',
      'Internal Order#': '56631',
      'Invoice Email': 'information@bascianiexpress.com',
      'Detention Policy':
        '2 hours free time; $50.00/hour after; must notify 1 hour before detention begins',
    });
  });

  it('ignores unrelated dispatcher free-text lines', () => {
    const parsed = parseApprovedNotesFields(
      'Driver must call 30 min out.\nMileage: 112 Miles\nCall dock before arrival.',
    );
    expect(parsed.Mileage).toBe('112 Miles');
    expect(Object.values(parsed).filter(Boolean)).toEqual(['112 Miles']);
  });

  it('returns all-null for empty/missing notes', () => {
    const parsed = parseApprovedNotesFields(null);
    expect(Object.values(parsed).every((v) => v === null)).toBe(true);
  });

  it('never matches a label not in the approved 8 (e.g. Carrier Name)', () => {
    const parsed = parseApprovedNotesFields('Carrier Name: MG CARGO INC\nMileage: 112 Miles');
    expect(Object.values(parsed).filter(Boolean)).toEqual(['112 Miles']);
  });
});

describe('buildDriverDispatchMessage — subject', () => {
  it('generates the subject dynamically from loadNumber, never hard-coded', () => {
    const { subject } = buildDriverDispatchMessage(baseInput({ loadNumber: '99999' }));
    expect(subject).toBe('Dispatch Details — Load #99999');
  });
});

describe('buildDriverDispatchMessage — body, full example', () => {
  it('matches the approved example exactly, end to end', () => {
    const { body } = buildDriverDispatchMessage(baseInput());
    expect(body).toBe(
      [
        '🚛 Carrier: MG CARGO INC',
        '🔗 Driver/Dispatch: Julia — (773) 870-1332',
        '🔑 Reefer Ref#: MR2',
        '🔑 Special Instructions: reefer pre cooled to 32 degrees',
        '📦 Commodity: Truckload of Produce — 42,365 lbs',
        '',
        'PICKUP:',
        'I Love Produce',
        '15 Commerce Blvd',
        'West Grove, PA 19390',
        '📅 09/02/26 at 8:00 AM',
        'Contact: Eric Frasse — (610) 212-1201',
        '',
        'DELIVERY:',
        'Jetro % Americold',
        '501 Kentile Rd',
        'South Plainfield, NJ 07080',
        '📅 09/02/26 at 2:00 PM',
        'Contact: (908) 756-6242',
        '',
        'PO: 120-25370',
        '💰 Rate: $950.00',
        '📋 Order #: 56631',
        '',
        'Mileage: 112 Miles',
        'Invoice Email: information@bascianiexpress.com',
        'Detention Policy: 2 hours free time; $50.00/hour after; must notify 1 hour before detention begins',
        '',
        'Important: Call Basciani Express to get dispatched before heading to pickup. Daily updates are required until delivery.',
      ].join('\n'),
    );
  });
});

describe('buildDriverDispatchMessage — missing optional fields produce clean output', () => {
  it('omits both Reefer lines entirely when no reefer notes are present', () => {
    const { body } = buildDriverDispatchMessage(baseInput({ pickupStopNotes: null }));
    expect(body).not.toContain('🔑 Reefer Ref#');
    expect(body).not.toContain('🔑 Special Instructions');
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('null');
  });

  it('omits Reefer Ref# and Special Instructions independently when only one is present', () => {
    const withRefOnly = buildDriverDispatchMessage(
      baseInput({ pickupStopNotes: 'Reefer Ref#: MR2' }),
    ).body;
    expect(withRefOnly).toContain('🔑 Reefer Ref#: MR2');
    expect(withRefOnly).not.toContain('🔑 Special Instructions');

    const withInstructionsOnly = buildDriverDispatchMessage(
      baseInput({ pickupStopNotes: 'Special Instructions: keep frozen' }),
    ).body;
    expect(withInstructionsOnly).toContain('🔑 Special Instructions: keep frozen');
    expect(withInstructionsOnly).not.toContain('🔑 Reefer Ref#');
  });

  it('omits the Commodity line when neither Commodity nor Pickup Weight is present', () => {
    const { body } = buildDriverDispatchMessage(
      baseInput({ pickupStopNotes: 'Mileage: 50 Miles' }),
    );
    expect(body).not.toContain('📦 Commodity');
  });

  it('omits PO/Rate/Order # lines individually when absent, without a dangling label', () => {
    const { body } = buildDriverDispatchMessage(
      baseInput({ customerPoNumber: null, customerRate: null, pickupStopNotes: null }),
    );
    expect(body).not.toContain('PO:');
    expect(body).not.toContain('💰 Rate');
    expect(body).not.toContain('📋 Order #');
  });

  it('omits the additional-information section entirely when none of its 3 fields are present', () => {
    const { body } = buildDriverDispatchMessage(baseInput({ pickupStopNotes: 'Reefer Ref#: MR2' }));
    expect(body).not.toContain('Mileage:');
    expect(body).not.toContain('Invoice Email:');
    expect(body).not.toContain('Detention Policy:');
  });

  it('omits a stop appointment line when appointmentDatetime is null', () => {
    const { body } = buildDriverDispatchMessage(
      baseInput({
        stops: [
          {
            stopType: 'PICKUP',
            companyName: 'Shipper A',
            addressLine1: '1 St',
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
            appointmentDatetime: null,
            contactName: null,
            contactPhone: null,
          },
        ],
      }),
    );
    expect(body).not.toContain('📅');
    expect(body).not.toContain('Contact:');
  });

  it('never produces the literal strings "undefined" or "null" anywhere in the body', () => {
    const { body } = buildDriverDispatchMessage(
      baseInput({
        customerPoNumber: null,
        customerRate: null,
        pickupStopNotes: null,
        stops: [
          {
            stopType: 'PICKUP',
            companyName: null,
            addressLine1: null,
            city: null,
            state: null,
            zip: null,
            appointmentDatetime: null,
            contactName: null,
            contactPhone: null,
          },
        ],
      }),
    );
    expect(body).not.toMatch(/undefined/i);
    expect(body).not.toMatch(/\bnull\b/i);
  });
});

describe('buildDriverDispatchMessage — approved Notes fields mapped correctly, no duplication', () => {
  it('keeps Reefer Ref# and Special Instructions as two distinct lines, never merged', () => {
    const { body } = buildDriverDispatchMessage(baseInput());
    const lines = body.split('\n');
    expect(lines).toContain('🔑 Reefer Ref#: MR2');
    expect(lines).toContain('🔑 Special Instructions: reefer pre cooled to 32 degrees');
    // Never combined into a single "Reefer" line.
    expect(body).not.toMatch(/🔑 Reefer:/);
    expect(body).not.toContain('MR2 — reefer pre cooled to 32 degrees');
    // Not duplicated into the additional-information section.
    expect(body.split('MR2').length - 1).toBe(1);
    expect(body.split('reefer pre cooled to 32 degrees').length - 1).toBe(1);
  });

  it('maps Commodity + Pickup Weight into the Commodity line only', () => {
    const { body } = buildDriverDispatchMessage(baseInput());
    const commodityLine = body.split('\n').find((l) => l.startsWith('📦 Commodity'));
    expect(commodityLine).toBe('📦 Commodity: Truckload of Produce — 42,365 lbs');
  });

  it('maps Internal Order# into the Order # line only, not the additional-information section', () => {
    const { body } = buildDriverDispatchMessage(baseInput());
    expect(body).toContain('📋 Order #: 56631');
    const occurrences = body.split('56631').length - 1;
    expect(occurrences).toBe(1);
  });

  it('places Mileage, Invoice Email, and Detention Policy in the additional-information section', () => {
    const { body } = buildDriverDispatchMessage(baseInput());
    expect(body).toContain('Mileage: 112 Miles');
    expect(body).toContain('Invoice Email: information@bascianiexpress.com');
    expect(body).toContain(
      'Detention Policy: 2 hours free time; $50.00/hour after; must notify 1 hour before detention begins',
    );
  });

  it('never includes an unrelated dispatcher note left in the same Notes field', () => {
    const { body } = buildDriverDispatchMessage(
      baseInput({ pickupStopNotes: `${APPROVED_NOTES}\nDriver must call 30 min out.` }),
    );
    expect(body).not.toContain('Driver must call 30 min out.');
  });
});

describe('buildDriverDispatchMessage — stop ordering and multi-stop support', () => {
  it('supports any number/mix of stops, in document order, never hard-coded to exactly 2', () => {
    const { body } = buildDriverDispatchMessage(
      baseInput({
        stops: [
          {
            stopType: 'PICKUP',
            companyName: 'A',
            addressLine1: null,
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
            appointmentDatetime: null,
            contactName: null,
            contactPhone: null,
          },
          {
            stopType: 'PICKUP',
            companyName: 'B',
            addressLine1: null,
            city: 'Memphis',
            state: 'TN',
            zip: '38103',
            appointmentDatetime: null,
            contactName: null,
            contactPhone: null,
          },
          {
            stopType: 'DELIVERY',
            companyName: 'C',
            addressLine1: null,
            city: 'Atlanta',
            state: 'GA',
            zip: '30301',
            appointmentDatetime: null,
            contactName: null,
            contactPhone: null,
          },
        ],
      }),
    );
    const order = body
      .split('\n')
      .filter((l) => l === 'PICKUP:' || l === 'DELIVERY:')
      .join(',');
    expect(order).toBe('PICKUP:,PICKUP:,DELIVERY:');
  });
});
