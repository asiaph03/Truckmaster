import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { LoadCreatePage } from './LoadCreatePage';
import type { ExtractedRateConfirmationData } from '../../api/rateConfirmationExtraction';

const CUSTOMERS = [
  { id: 'cust-1', legalName: 'Acme Freight LLC', status: 'ACTIVE' },
  { id: 'cust-2', legalName: 'Beta Logistics', status: 'ACTIVE' },
  { id: 'cust-3', legalName: 'Pending Approval Carriers Inc', status: 'PROSPECT' },
];

/**
 * SearchableCombobox's <input> has no `id`/`htmlFor` association with its
 * <label> (a pre-existing gap, not something this feature touches or is
 * asked to fix), so it can't be found via getByLabelText — its default
 * placeholder ("Search…") is the only reliable selector, and since this
 * page has exactly one combobox, it's unambiguous.
 *
 * The combobox also renders no visible text at all until it's either
 * focused (opens its options panel) or has a selected value — so
 * "customers have loaded" can't be observed via a plain findByText
 * against the closed input. Opening the panel is also the one reliable
 * way to confirm `handleExtracted`'s customer-matching runs against the
 * real, already-loaded list rather than a stale empty-array closure.
 */
function customerComboboxInput() {
  return screen.getByPlaceholderText('Search…');
}

async function waitForCustomersLoaded() {
  fireEvent.focus(customerComboboxInput());
  await screen.findByText('Acme Freight LLC (ACTIVE)');
  fireEvent.blur(customerComboboxInput());
}

function renderPage(initialPath = '/loads/new') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(http.get('/api/v1/customers', () => HttpResponse.json(CUSTOMERS)));
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <LoadCreatePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Drives the dropzone through initiate -> upload -> confirm -> poll-to-COMPLETE with the given extraction result. */
async function uploadAndExtract(data: ExtractedRateConfirmationData) {
  server.use(
    http.post('/api/v1/rate-confirmation-extractions', () =>
      HttpResponse.json(
        { extractionId: 'ex-1', uploadUrl: 'https://fake-upload.test/put' },
        { status: 201 },
      ),
    ),
    http.put('https://fake-upload.test/put', () => new HttpResponse(null, { status: 200 })),
    http.post('/api/v1/rate-confirmation-extractions/ex-1/confirm', () =>
      HttpResponse.json({ extractionId: 'ex-1', scanStatus: 'PENDING' }),
    ),
    http.get('/api/v1/rate-confirmation-extractions/ex-1', () =>
      HttpResponse.json({
        extractionId: 'ex-1',
        scanStatus: 'CLEAN',
        extractionStatus: 'COMPLETE',
        extractionError: null,
        data,
      }),
    ),
  );

  const file = new File(['%PDF-1.4 fake'], 'ratecon.pdf', { type: 'application/pdf' });
  const input = document.querySelector('.rate-confirmation-dropzone-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(screen.getByText('Extracted — review below')).toBeInTheDocument(), {
    timeout: 5000,
  });
}

function extractedCustomer(extractedName: string) {
  return {
    extractedName,
    billingAddressLine1: null,
    billingCity: null,
    billingState: null,
    billingZip: null,
    primaryContactName: null,
    primaryContactEmail: null,
    primaryContactPhone: null,
  };
}

function baseExtraction(overrides: Partial<ExtractedRateConfirmationData> = {}) {
  return {
    customer: null,
    equipmentType: null,
    customerRate: null,
    customerPoNumber: null,
    bolNumber: null,
    pickupNumber: null,
    customerReferenceNumber: null,
    stops: [],
    warnings: [],
    unmappedFields: [],
    ...overrides,
  } satisfies ExtractedRateConfirmationData;
}

describe('LoadCreatePage — Rate Confirmation extraction', () => {
  it('populates equipment, rate, and reference fields from a completed extraction', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        equipmentType: 'REEFER',
        customerRate: '2500.00',
        customerPoNumber: 'PO-123',
        bolNumber: 'BOL-456',
      }),
    );

    expect((screen.getByLabelText(/^Equipment Type/) as HTMLSelectElement).value).toBe('REEFER');
    expect((screen.getByLabelText(/^Customer Rate/) as HTMLInputElement).value).toContain('2500');
    expect((screen.getByLabelText(/^Customer PO Number/) as HTMLInputElement).value).toBe('PO-123');
    expect((screen.getByLabelText(/^BOL Number/) as HTMLInputElement).value).toBe('BOL-456');
  });

  it('never auto-selects an equipment value outside the 3 valid enum values', async () => {
    renderPage();
    await waitForCustomersLoaded();

    // Cast bypasses the TS union on purpose — this simulates a
    // malformed/unexpected value slipping through, which the frontend
    // must defend against independently of the backend's own check.
    // Note: the Select has no blank placeholder option (a pre-existing,
    // unrelated-to-this-feature gap in LoadCreatePage's own markup), so
    // an untouched native <select> reports its first option's value
    // ("DRY_VAN") rather than "" — the assertion here is specifically
    // that the OUT-OF-ENUM value never gets selected, not that the field
    // reads as empty.
    await uploadAndExtract(baseExtraction({ equipmentType: 'BOX_TRUCK' as never }));

    expect((screen.getByLabelText(/^Equipment Type/) as HTMLSelectElement).value).not.toBe(
      'BOX_TRUCK',
    );
  });

  it('preserves exact stop order — PICKUP, DELIVERY, PICKUP, DELIVERY — never regrouped', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        stops: [
          {
            stopType: 'PICKUP',
            companyName: 'Shipper A',
            addressLine1: '1 Dock Rd',
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
            contactName: null,
            contactPhone: null,
            appointmentDatetime: null,
          },
          {
            stopType: 'DELIVERY',
            companyName: 'Consignee A',
            addressLine1: '2 Dock Rd',
            city: 'Chicago',
            state: 'IL',
            zip: '60601',
            contactName: null,
            contactPhone: null,
            appointmentDatetime: null,
          },
          {
            stopType: 'PICKUP',
            companyName: 'Shipper B',
            addressLine1: '3 Dock Rd',
            city: 'Memphis',
            state: 'TN',
            zip: '38103',
            contactName: null,
            contactPhone: null,
            appointmentDatetime: null,
          },
          {
            stopType: 'DELIVERY',
            companyName: 'Consignee B',
            addressLine1: '4 Dock Rd',
            city: 'Atlanta',
            state: 'GA',
            zip: '30301',
            contactName: null,
            contactPhone: null,
            appointmentDatetime: null,
          },
        ],
      }),
    );

    const companyNameInputs = screen.getAllByLabelText(/^Company Name/) as HTMLInputElement[];
    expect(companyNameInputs.map((i) => i.value)).toEqual([
      'Shipper A',
      'Consignee A',
      'Shipper B',
      'Consignee B',
    ]);
    const stopTypeSelects = screen.getAllByLabelText(/^Type/) as HTMLSelectElement[];
    expect(stopTypeSelects.map((s) => s.value)).toEqual([
      'PICKUP',
      'DELIVERY',
      'PICKUP',
      'DELIVERY',
    ]);
  });

  it('preserves a stop with unreadable fields — kept in the list with those fields blank, never dropped', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        stops: [
          {
            stopType: 'DELIVERY',
            companyName: 'ABC Distribution',
            addressLine1: null,
            city: 'Dallas',
            state: 'TX',
            zip: null,
            contactName: null,
            contactPhone: null,
            appointmentDatetime: null,
          },
        ],
      }),
    );

    expect(screen.getAllByLabelText(/^Company Name/)).toHaveLength(1);
    expect((screen.getByLabelText(/^Company Name/) as HTMLInputElement).value).toBe(
      'ABC Distribution',
    );
    expect((screen.getByLabelText(/^Address Line 1/) as HTMLInputElement).value).toBe('');
  });

  it('an exact-normalized customer name match auto-selects the existing customer, never creates one', async () => {
    let customerCreateCalls = 0;
    server.use(
      http.post('/api/v1/customers', () => {
        customerCreateCalls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    renderPage();
    await waitForCustomersLoaded();

    // Deliberately different case/punctuation — proves normalize()-based
    // matching, not a literal string comparison.
    await uploadAndExtract(baseExtraction({ customer: extractedCustomer('acme freight, llc.') }));

    expect(screen.getByDisplayValue('Acme Freight LLC (ACTIVE)')).toBeInTheDocument();
    expect(screen.queryByText(/Customer not found/)).not.toBeInTheDocument();
    expect(customerCreateCalls).toBe(0);
  });

  it('no customer match — leaves Customer unresolved, shows Create Customer, never auto-creates', async () => {
    let customerCreateCalls = 0;
    server.use(
      http.post('/api/v1/customers', () => {
        customerCreateCalls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({ customer: extractedCustomer('Totally New Shipper Co') }),
    );

    expect(screen.getByText(/Customer not found/)).toBeInTheDocument();
    expect(screen.getByText('"Totally New Shipper Co"')).toBeInTheDocument();
    expect(customerCreateCalls).toBe(0);
  });

  it('clicking Create Customer opens the modal prefilled with extracted values; explicit creation selects the new customer', async () => {
    server.use(
      http.post('/api/v1/customers', async ({ request }) => {
        const body = (await request.json()) as { legalName: string };
        return HttpResponse.json(
          { id: 'new-cust-1', legalName: body.legalName, status: 'PROSPECT' },
          { status: 201 },
        );
      }),
      // A freshly-created customer is always Prospect, so this now also
      // triggers a Load Draft save (see the dedicated describe block
      // below) — harmless handler, not asserted on here.
      http.post('/api/v1/load-drafts', () => HttpResponse.json({ id: 'draft-1' }, { status: 201 })),
    );
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        customer: {
          extractedName: 'Brand New Shipper Co',
          billingAddressLine1: '99 New St',
          billingCity: 'Austin',
          billingState: 'TX',
          billingZip: '78701',
          primaryContactName: null,
          primaryContactEmail: null,
          primaryContactPhone: null,
        },
      }),
    );

    fireEvent.click(screen.getByText('Create Customer'));

    await waitFor(() =>
      expect(screen.getByText('Create Customer', { selector: 'h2' })).toBeInTheDocument(),
    );
    expect((screen.getByLabelText(/^Legal Name/) as HTMLInputElement).value).toBe(
      'Brand New Shipper Co',
    );
    expect((screen.getByLabelText(/^Address Line 1/) as HTMLInputElement).value).toBe('99 New St');

    // Fill the fields the extraction couldn't find, matching "user must be able to edit those values."
    fireEvent.change(screen.getByLabelText(/^Contact Name/), { target: { value: 'Sam Rep' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'sam@newshipper.test' } });
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '555-0199' } });

    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Customer' }),
    );

    await waitFor(() => expect(screen.queryByText(/Customer not found/)).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('Brand New Shipper Co (PROSPECT)')).toBeInTheDocument();
  });

  it('extraction never calls POST /loads on its own', async () => {
    let loadCreateCalls = 0;
    server.use(
      http.post('/api/v1/loads', () => {
        loadCreateCalls += 1;
        return HttpResponse.json({ id: 'load-1' }, { status: 201 });
      }),
    );
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        equipmentType: 'DRY_VAN',
        customerRate: '1000.00',
        stops: [
          {
            stopType: 'PICKUP',
            companyName: 'A',
            addressLine1: '1 St',
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
            contactName: null,
            contactPhone: null,
            appointmentDatetime: null,
          },
          {
            stopType: 'DELIVERY',
            companyName: 'B',
            addressLine1: '2 St',
            city: 'Chicago',
            state: 'IL',
            zip: '60601',
            contactName: null,
            contactPhone: null,
            appointmentDatetime: null,
          },
        ],
      }),
    );

    expect(loadCreateCalls).toBe(0);
    expect(screen.getByRole('button', { name: 'Book Load' })).toBeInTheDocument();
  });
});

describe('LoadCreatePage — Load Draft feature (credit-saving: extraction happens at most once)', () => {
  it('an exact-normalized match to a non-Active customer saves a Load Draft and shows the approval-required banner', async () => {
    let createDraftBody: unknown;
    const draftResponse = {
      id: 'draft-1',
      customerId: 'cust-3',
      customerLegalName: 'Pending Approval Carriers Inc',
      customerStatus: 'PROSPECT',
      rateConfirmationDocumentId: 'doc-1',
      rateConfirmationFileName: 'ratecon.pdf',
      createdAt: '2026-09-04T00:00:00.000Z',
      extractedData: baseExtraction(),
    };
    server.use(
      http.post('/api/v1/load-drafts', async ({ request }) => {
        createDraftBody = await request.json();
        return HttpResponse.json(draftResponse, { status: 201 });
      }),
      // The page immediately follows up with GET /load-drafts/:id (the
      // same request a real page reload would make) to render the banner.
      http.get('/api/v1/load-drafts/draft-1', () => HttpResponse.json(draftResponse)),
    );
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({ customer: extractedCustomer('Pending Approval Carriers Inc') }),
    );

    await waitFor(() =>
      expect(screen.getByText('New Customer — Compliance Approval Required')).toBeInTheDocument(),
    );
    expect(screen.getByText('Pending Approval Carriers Inc')).toBeInTheDocument();
    expect(createDraftBody).toMatchObject({
      extractionId: 'ex-1',
      customerId: 'cust-3',
    });
    // The dropzone/upload UI is replaced by the draft summary — no way
    // to accidentally re-upload once a draft exists for this session.
    expect(document.querySelector('.rate-confirmation-dropzone-input')).not.toBeInTheDocument();
  });

  it('an exact-normalized match to an Active customer does NOT save a Load Draft', async () => {
    let draftCreateCalls = 0;
    server.use(
      http.post('/api/v1/load-drafts', () => {
        draftCreateCalls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(baseExtraction({ customer: extractedCustomer('acme freight, llc.') }));

    expect(draftCreateCalls).toBe(0);
    expect(
      screen.queryByText('New Customer — Compliance Approval Required'),
    ).not.toBeInTheDocument();
  });

  it('creating a brand-new customer (always Prospect) saves a Load Draft', async () => {
    let createDraftBody: unknown;
    const newCustomerDraftResponse = {
      id: 'draft-2',
      customerId: 'new-cust-1',
      customerLegalName: 'Brand New Shipper Co',
      customerStatus: 'PROSPECT',
      rateConfirmationDocumentId: 'doc-1',
      rateConfirmationFileName: 'ratecon.pdf',
      createdAt: '2026-09-04T00:00:00.000Z',
      extractedData: baseExtraction(),
    };
    server.use(
      http.post('/api/v1/customers', async ({ request }) => {
        const body = (await request.json()) as { legalName: string };
        return HttpResponse.json(
          { id: 'new-cust-1', legalName: body.legalName, status: 'PROSPECT' },
          { status: 201 },
        );
      }),
      http.post('/api/v1/load-drafts', async ({ request }) => {
        createDraftBody = await request.json();
        return HttpResponse.json(newCustomerDraftResponse, { status: 201 });
      }),
      // Follow-up GET, same as any real page reload would make.
      http.get('/api/v1/load-drafts/draft-2', () => HttpResponse.json(newCustomerDraftResponse)),
    );
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        customer: {
          extractedName: 'Brand New Shipper Co',
          billingAddressLine1: '99 New St',
          billingCity: 'Austin',
          billingState: 'TX',
          billingZip: '78701',
          primaryContactName: null,
          primaryContactEmail: null,
          primaryContactPhone: null,
        },
      }),
    );
    fireEvent.click(screen.getByText('Create Customer'));
    await waitFor(() =>
      expect(screen.getByText('Create Customer', { selector: 'h2' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/^Contact Name/), { target: { value: 'Sam Rep' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'sam@newshipper.test' } });
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '555-0199' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Customer' }),
    );

    await waitFor(() =>
      expect(screen.getByText('New Customer — Compliance Approval Required')).toBeInTheDocument(),
    );
    expect(createDraftBody).toMatchObject({ extractionId: 'ex-1', customerId: 'new-cust-1' });
  });

  it('resuming a draft via ?draftId= restores every field, hides the upload dropzone, and makes ZERO extraction network calls', async () => {
    let extractionInitiateCalls = 0;
    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () => {
        extractionInitiateCalls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
      // The live-status query (customersApi.getById) is what actually
      // drives the banner/Book Load enablement now — the fixture list
      // still has cust-3 as PROSPECT, this is the current/live value.
      http.get('/api/v1/customers/cust-3', () =>
        HttpResponse.json({
          id: 'cust-3',
          legalName: 'Pending Approval Carriers Inc',
          status: 'ACTIVE',
        }),
      ),
      http.get('/api/v1/load-drafts/draft-1', () =>
        HttpResponse.json({
          id: 'draft-1',
          customerId: 'cust-3',
          customerLegalName: 'Pending Approval Carriers Inc',
          customerStatus: 'ACTIVE',
          rateConfirmationDocumentId: 'doc-1',
          rateConfirmationFileName: 'ratecon.pdf',
          createdAt: '2026-09-04T00:00:00.000Z',
          extractedData: baseExtraction({
            equipmentType: 'REEFER',
            customerRate: '3100.00',
            customerPoNumber: 'PO-999',
            stops: [
              {
                stopType: 'PICKUP',
                companyName: 'Resumed Shipper',
                addressLine1: '1 Dock Rd',
                city: 'Dallas',
                state: 'TX',
                zip: '75201',
                contactName: null,
                contactPhone: null,
                appointmentDatetime: null,
              },
            ],
          }),
        }),
      ),
    );

    renderPage('/loads/new?draftId=draft-1');
    await waitForCustomersLoaded();

    await waitFor(() =>
      expect(screen.getByText('Customer Approved — Ready to Book')).toBeInTheDocument(),
    );
    expect(
      screen.getByDisplayValue('Pending Approval Carriers Inc (PROSPECT)'),
    ).toBeInTheDocument();
    expect((screen.getByLabelText(/^Equipment Type/) as HTMLSelectElement).value).toBe('REEFER');
    expect((screen.getByLabelText(/^Customer Rate/) as HTMLInputElement).value).toContain('3100');
    expect((screen.getByLabelText(/^Company Name/) as HTMLInputElement).value).toBe(
      'Resumed Shipper',
    );
    expect(document.querySelector('.rate-confirmation-dropzone-input')).not.toBeInTheDocument();
    // The whole point — resuming must never re-invoke extraction.
    expect(extractionInitiateCalls).toBe(0);
    expect(screen.getByRole('button', { name: /View Rate Confirmation PDF/ })).toBeInTheDocument();
  });

  it('Book Load deletes the now-consumed draft after a successful booking', async () => {
    let deleteCalls = 0;
    server.use(
      http.get('/api/v1/load-drafts/draft-1', () =>
        HttpResponse.json({
          id: 'draft-1',
          customerId: 'cust-1',
          customerLegalName: 'Acme Freight LLC',
          customerStatus: 'ACTIVE',
          rateConfirmationDocumentId: 'doc-1',
          rateConfirmationFileName: 'ratecon.pdf',
          createdAt: '2026-09-04T00:00:00.000Z',
          extractedData: baseExtraction({
            equipmentType: 'DRY_VAN',
            customerRate: '1200.00',
            stops: [
              {
                stopType: 'PICKUP',
                companyName: 'A',
                addressLine1: '1 St',
                city: 'Dallas',
                state: 'TX',
                zip: '75201',
                contactName: null,
                contactPhone: null,
                appointmentDatetime: null,
              },
              {
                stopType: 'DELIVERY',
                companyName: 'B',
                addressLine1: '2 St',
                city: 'Chicago',
                state: 'IL',
                zip: '60601',
                contactName: null,
                contactPhone: null,
                appointmentDatetime: null,
              },
            ],
          }),
        }),
      ),
      http.post('/api/v1/loads', () => HttpResponse.json({ id: 'load-1' }, { status: 201 })),
      http.delete('/api/v1/load-drafts/draft-1', () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPage('/loads/new?draftId=draft-1');
    await waitForCustomersLoaded();
    await waitFor(() =>
      expect(screen.getByText('Customer Approved — Ready to Book')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Book Load' }));

    await waitFor(() => expect(deleteCalls).toBe(1));
  });

  it('WORKFLOW A (stay on page): upload -> extraction -> PROSPECT draft -> focus revalidation to ACTIVE -> Book Load succeeds, with exactly ONE extraction total', async () => {
    let customerStatus: 'PROSPECT' | 'ACTIVE' = 'PROSPECT';
    const extractedWithStops = baseExtraction({
      customerPoNumber: 'PO-777',
      equipmentType: 'DRY_VAN',
      customerRate: '1500.00',
      stops: [
        {
          stopType: 'PICKUP',
          companyName: 'A',
          addressLine1: '1 St',
          city: 'Dallas',
          state: 'TX',
          zip: '75201',
          contactName: null,
          contactPhone: null,
          appointmentDatetime: null,
        },
        {
          stopType: 'DELIVERY',
          companyName: 'B',
          addressLine1: '2 St',
          city: 'Chicago',
          state: 'IL',
          zip: '60601',
          contactName: null,
          contactPhone: null,
          appointmentDatetime: null,
        },
      ],
    });
    let loadCreateCalls = 0;
    let deleteCalls = 0;
    server.use(
      // 1. A selected non-Active customer — the mock reflects whatever
      // the "current" live status is, exactly like a real backend would.
      http.get('/api/v1/customers/cust-3', () =>
        HttpResponse.json({
          id: 'cust-3',
          legalName: 'Pending Approval Carriers Inc',
          status: customerStatus,
        }),
      ),
      http.post('/api/v1/load-drafts', () =>
        HttpResponse.json(
          {
            id: 'draft-1',
            customerId: 'cust-3',
            customerLegalName: 'Pending Approval Carriers Inc',
            customerStatus: 'PROSPECT',
            rateConfirmationDocumentId: 'doc-1',
            rateConfirmationFileName: 'ratecon.pdf',
            createdAt: '2026-09-04T00:00:00.000Z',
            extractedData: extractedWithStops,
          },
          { status: 201 },
        ),
      ),
      http.get('/api/v1/load-drafts/draft-1', () =>
        HttpResponse.json({
          id: 'draft-1',
          customerId: 'cust-3',
          customerLegalName: 'Pending Approval Carriers Inc',
          customerStatus: 'PROSPECT',
          rateConfirmationDocumentId: 'doc-1',
          rateConfirmationFileName: 'ratecon.pdf',
          createdAt: '2026-09-04T00:00:00.000Z',
          extractedData: extractedWithStops,
        }),
      ),
      http.post('/api/v1/loads', () => {
        loadCreateCalls += 1;
        return HttpResponse.json({ id: 'load-1' }, { status: 201 });
      }),
      http.delete('/api/v1/load-drafts/draft-1', () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        ...extractedWithStops,
        customer: extractedCustomer('Pending Approval Carriers Inc'),
      }),
    );

    // 1 & 2. Non-Active customer selected; Book Load disabled.
    await waitFor(() =>
      expect(screen.getByText('New Customer — Compliance Approval Required')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Book Load' })).toBeDisabled();

    // Only NOW start tracking extraction-initiate calls — the initial
    // upload has already fully completed above (exactly once). What
    // matters from here is that NOTHING — not the focus-triggered
    // revalidation, not the eventual booking — ever causes a second one.
    let extractionInitiateCallsAfterUpload = 0;
    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () => {
        extractionInitiateCallsAfterUpload += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    // 3. Customer status changes to ACTIVE — externally, in another
    // session; nothing on this page causes it or knows about it yet.
    customerStatus = 'ACTIVE';

    // 4. Page regains focus — the only trigger; not a timer, not a poll.
    await act(async () => {
      focusManager.setFocused(true);
    });

    // 5 & 6. UI updates to the approved state; Book Load enables —
    // entirely from the live customer query, no draft re-fetch needed,
    // no user navigation, no re-upload.
    await waitFor(() =>
      expect(screen.getByText('Customer Approved — Ready to Book')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Book Load' })).not.toBeDisabled();

    // The originally-extracted data is still exactly what's in the form
    // — a customer-status revalidation never touches unrelated state.
    expect((screen.getByLabelText(/^Customer PO Number/) as HTMLInputElement).value).toBe('PO-777');

    // Finish the workflow — actually book it.
    fireEvent.click(screen.getByRole('button', { name: 'Book Load' }));
    await waitFor(() => expect(loadCreateCalls).toBe(1));
    await waitFor(() => expect(deleteCalls).toBe(1));

    // 7 & 8. No re-upload, no re-extraction, across the ENTIRE workflow
    // including the final booking step — the only way an Anthropic call
    // could ever be triggered from this page is a new call to this
    // endpoint, and there wasn't one after the original upload.
    expect(extractionInitiateCallsAfterUpload).toBe(0);
    expect(document.querySelector('.rate-confirmation-dropzone-input')).not.toBeInTheDocument();
  });

  it('WORKFLOW B (leave and resume): upload -> extraction -> PROSPECT draft -> leave page -> customer becomes ACTIVE -> resume -> Book Load succeeds, with exactly ONE extraction total', async () => {
    const extractedWithStops = baseExtraction({
      customerPoNumber: 'PO-888',
      equipmentType: 'FLATBED',
      customerRate: '2200.00',
      stops: [
        {
          stopType: 'PICKUP',
          companyName: 'Resumed Shipper',
          addressLine1: '1 Dock Rd',
          city: 'Dallas',
          state: 'TX',
          zip: '75201',
          contactName: null,
          contactPhone: null,
          appointmentDatetime: null,
        },
        {
          stopType: 'DELIVERY',
          companyName: 'Resumed Receiver',
          addressLine1: '2 Dock Rd',
          city: 'Chicago',
          state: 'IL',
          zip: '60601',
          contactName: null,
          contactPhone: null,
          appointmentDatetime: null,
        },
      ],
    });
    let customerStatus: 'PROSPECT' | 'ACTIVE' = 'PROSPECT';
    let extractionInitiateCalls = 0;
    let loadCreateCalls = 0;
    let deleteCalls = 0;
    server.use(
      http.get('/api/v1/customers/cust-3', () =>
        HttpResponse.json({
          id: 'cust-3',
          legalName: 'Pending Approval Carriers Inc',
          status: customerStatus,
        }),
      ),
      http.post('/api/v1/load-drafts', () =>
        HttpResponse.json(
          {
            id: 'draft-1',
            customerId: 'cust-3',
            customerLegalName: 'Pending Approval Carriers Inc',
            customerStatus: 'PROSPECT',
            rateConfirmationDocumentId: 'doc-1',
            rateConfirmationFileName: 'ratecon.pdf',
            createdAt: '2026-09-04T00:00:00.000Z',
            extractedData: extractedWithStops,
          },
          { status: 201 },
        ),
      ),
      http.get('/api/v1/load-drafts/draft-1', () =>
        HttpResponse.json({
          id: 'draft-1',
          customerId: 'cust-3',
          customerLegalName: 'Pending Approval Carriers Inc',
          customerStatus: 'PROSPECT',
          rateConfirmationDocumentId: 'doc-1',
          rateConfirmationFileName: 'ratecon.pdf',
          createdAt: '2026-09-04T00:00:00.000Z',
          extractedData: extractedWithStops,
        }),
      ),
      http.post('/api/v1/loads', () => {
        loadCreateCalls += 1;
        return HttpResponse.json({ id: 'load-1' }, { status: 201 });
      }),
      http.delete('/api/v1/load-drafts/draft-1', () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    // --- Session 1: upload, extract, draft gets saved (PROSPECT customer) ---
    const session1 = renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        ...extractedWithStops,
        customer: extractedCustomer('Pending Approval Carriers Inc'),
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('New Customer — Compliance Approval Required')).toBeInTheDocument(),
    );

    // Only NOW start counting — the one real upload/extraction has
    // already happened. Nothing from this point on (leaving, an
    // external status change, resuming, or booking) may add to it.
    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () => {
        extractionInitiateCalls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    // --- Leave the page: a real unmount, not just a state reset ---
    session1.unmount();

    // Customer becomes ACTIVE externally, while nobody has this page open.
    customerStatus = 'ACTIVE';

    // --- Session 2: resume via the URL a "Load Drafts" list would link to ---
    renderPage('/loads/new?draftId=draft-1');
    await waitForCustomersLoaded();

    // extractedData is restored entirely from the persisted LoadDraft —
    // no dropzone, no extraction call, and the customer is already
    // ACTIVE (ready), because the draft's live customer query reflects
    // reality independent of what the draft snapshot itself once said.
    await waitFor(() =>
      expect(screen.getByText('Customer Approved — Ready to Book')).toBeInTheDocument(),
    );
    expect((screen.getByLabelText(/^Customer PO Number/) as HTMLInputElement).value).toBe('PO-888');
    expect((screen.getByLabelText(/^Equipment Type/) as HTMLSelectElement).value).toBe('FLATBED');
    expect((screen.getAllByLabelText(/^Company Name/)[0] as HTMLInputElement).value).toBe(
      'Resumed Shipper',
    );
    expect(document.querySelector('.rate-confirmation-dropzone-input')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book Load' })).not.toBeDisabled();

    // Finish the workflow — actually book it, and confirm the draft is cleaned up.
    fireEvent.click(screen.getByRole('button', { name: 'Book Load' }));
    await waitFor(() => expect(loadCreateCalls).toBe(1));
    await waitFor(() => expect(deleteCalls).toBe(1));

    // The whole point of Workflow B — zero extraction calls after the
    // one original upload, across leaving, the external status change,
    // resuming, and the final booking.
    expect(extractionInitiateCalls).toBe(0);
  });
});

function pickupThenDelivery() {
  return [
    {
      stopType: 'PICKUP' as const,
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
      stopType: 'DELIVERY' as const,
      companyName: 'Jetro % Americold',
      addressLine1: '501 Kentile Rd',
      city: 'SOUTH PLAINFIELD',
      state: 'NJ',
      zip: '07080',
      contactName: 'Receiving',
      contactPhone: '(908) 756-6242',
      appointmentDatetime: '2026-09-02T14:00',
    },
  ];
}

describe('LoadCreatePage — extracted "Additional Information" auto-placed into stop Notes', () => {
  it('all 8 approved fields populate the pickup stop Notes field, in the documented order', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        stops: pickupThenDelivery(),
        unmappedFields: [
          { label: 'Reefer Ref#', value: 'MR2' },
          { label: 'Mileage', value: '112 Miles' },
          { label: 'Commodity', value: 'Truckload of Produce' },
          { label: 'Weight', value: '42,365 lbs' },
          { label: 'Special Instructions', value: 'reefer pre cooled to 32 degrees' },
          { label: 'Internal Order#', value: '56631' },
          { label: 'Invoice Email', value: 'information@bascianiexpress.com' },
          {
            label: 'Detention Policy',
            value:
              '2 hours free time; $50.00/hour after; must notify 1 hour before detention begins',
          },
        ],
      }),
    );

    const notes = screen.getAllByLabelText('Notes')[0] as HTMLTextAreaElement;
    expect(notes.value).toBe(
      [
        'Reefer Ref#: MR2',
        'Mileage: 112 Miles',
        'Commodity: Truckload of Produce',
        'Pickup Weight: 42,365 lbs',
        'Special Instructions: reefer pre cooled to 32 degrees',
        'Internal Order#: 56631',
        'Invoice Email: information@bascianiexpress.com',
        'Detention Policy: 2 hours free time; $50.00/hour after; must notify 1 hour before detention begins',
      ].join('\n'),
    );
  });

  it('omits missing/blank approved fields — no blank lines, no labels with no value', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        stops: pickupThenDelivery(),
        unmappedFields: [
          { label: 'Mileage', value: '112 Miles' },
          { label: 'Special Instructions', value: 'reefer pre cooled to 32 degrees' },
        ],
      }),
    );

    const notes = screen.getAllByLabelText('Notes')[0] as HTMLTextAreaElement;
    expect(notes.value).toBe(
      'Mileage: 112 Miles\nSpecial Instructions: reefer pre cooled to 32 degrees',
    );
    expect(notes.value).not.toContain('\n\n');
    expect(notes.value).not.toMatch(/:\s*$/m);
  });

  it('preserves existing user-entered Notes text and appends the extracted block rather than overwriting it', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(baseExtraction({ stops: pickupThenDelivery() }));

    const notesBeforeSecondUpload = screen.getAllByLabelText('Notes')[0] as HTMLTextAreaElement;
    fireEvent.change(notesBeforeSecondUpload, {
      target: { value: 'Driver must call 30 min out.' },
    });
    expect(notesBeforeSecondUpload.value).toBe('Driver must call 30 min out.');

    fireEvent.click(screen.getByText('Remove'));
    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () =>
        HttpResponse.json(
          { extractionId: 'ex-2', uploadUrl: 'https://fake-upload.test/put2' },
          { status: 201 },
        ),
      ),
      http.put('https://fake-upload.test/put2', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/rate-confirmation-extractions/ex-2/confirm', () =>
        HttpResponse.json({ extractionId: 'ex-2', scanStatus: 'PENDING' }),
      ),
      http.get('/api/v1/rate-confirmation-extractions/ex-2', () =>
        HttpResponse.json({
          extractionId: 'ex-2',
          scanStatus: 'CLEAN',
          extractionStatus: 'COMPLETE',
          extractionError: null,
          data: baseExtraction({
            stops: pickupThenDelivery(),
            unmappedFields: [{ label: 'Mileage', value: '112 Miles' }],
          }),
        }),
      ),
    );
    const secondFile = new File(['%PDF-1.4 fake'], 'ratecon2.pdf', { type: 'application/pdf' });
    const input = document.querySelector('.rate-confirmation-dropzone-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [secondFile] } });
    await waitFor(() => expect(screen.getByText('Extracted — review below')).toBeInTheDocument(), {
      timeout: 5000,
    });

    const notesAfter = screen.getAllByLabelText('Notes')[0] as HTMLTextAreaElement;
    expect(notesAfter.value).toBe('Driver must call 30 min out.\n\nMileage: 112 Miles');
  });

  it('never adds non-approved fields (e.g. Carrier Name, Carrier Contact) to Notes', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        stops: pickupThenDelivery(),
        unmappedFields: [
          { label: 'Carrier Name', value: 'MG CARGO INC' },
          { label: 'Carrier Contact', value: 'Jane Dispatcher' },
          { label: 'Mileage', value: '112 Miles' },
        ],
      }),
    );

    const notes = screen.getAllByLabelText('Notes')[0] as HTMLTextAreaElement;
    expect(notes.value).toBe('Mileage: 112 Miles');
    expect(notes.value).not.toContain('MG CARGO INC');
    expect(notes.value).not.toContain('Carrier');
  });

  it('never duplicates dedicated Load/Stop field values into Notes', async () => {
    renderPage();
    await waitForCustomersLoaded();

    await uploadAndExtract(
      baseExtraction({
        customer: extractedCustomer('Basciani Express'),
        equipmentType: 'REEFER',
        customerRate: '950.00',
        customerPoNumber: '120-25370',
        stops: pickupThenDelivery(),
        unmappedFields: [{ label: 'Mileage', value: '112 Miles' }],
      }),
    );

    const notes = screen.getAllByLabelText('Notes')[0] as HTMLTextAreaElement;
    expect(notes.value).toBe('Mileage: 112 Miles');
    // Dedicated-field values stay in their own fields — never copied into Notes.
    expect(notes.value).not.toContain('Basciani Express');
    expect(notes.value).not.toContain('950.00');
    expect(notes.value).not.toContain('120-25370');
    expect(notes.value).not.toContain('I Love Produce');
  });
});
