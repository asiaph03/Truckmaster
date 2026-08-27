import { PdfkitPdfGenerator } from './pdfkit-pdf-generator';

describe('PdfkitPdfGenerator', () => {
  const generator = new PdfkitPdfGenerator();

  it('generateRateConfirmation returns real PDF bytes (not placeholder text)', async () => {
    const bytes = await generator.generateRateConfirmation({
      loadNumber: 'LOAD-000001',
      carrierLegalName: 'Acme Trucking',
      carrierRate: '1500.00',
      customerLegalName: 'Acme Shipper',
      equipmentType: 'DRY_VAN',
      stops: [
        { sequence: 2, stopType: 'DELIVERY', city: 'Chicago', state: 'IL' },
        { sequence: 1, stopType: 'PICKUP', city: 'Dallas', state: 'TX' },
      ],
    });

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('generateInvoice returns real PDF bytes', async () => {
    const bytes = await generator.generateInvoice({
      invoiceNumber: 'INV-000001',
      customerLegalName: 'Acme Shipper',
      status: 'SENT',
      total: '2400.00',
      remainingBalance: '2400.00',
      lineItems: [{ description: 'Linehaul', amount: '2400.00' }],
    });

    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('generateSettlement returns real PDF bytes', async () => {
    const bytes = await generator.generateSettlement({
      carrierLegalName: 'Acme Trucking',
      loadNumber: 'LOAD-000001',
      paymentAmount: '1500.00',
      paymentType: 'FACTORED',
      paymentDate: '2026-01-01',
    });

    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});
