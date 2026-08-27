import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  IPdfGenerator,
  InvoicePdfInput,
  RateConfirmationPdfInput,
  SettlementPdfInput,
} from './pdf-generator.interface';

/**
 * Frontend Phase 16 — in-process PDF generator, approved to replace
 * StubPdfGenerator behind the unchanged IPdfGenerator interface. All
 * three documents are simple structured business documents (a handful of
 * labeled fields plus a short list) with no locked branding/letterhead
 * requirement (checked against UI_UX_DESIGN.md's brand rules, which
 * govern the web app UI, not these generated documents) — PDFKit's
 * text-flow API is sufficient without an HTML/CSS rendering engine.
 */
@Injectable()
export class PdfkitPdfGenerator implements IPdfGenerator {
  private renderToBuffer(render: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      render(doc);
      doc.end();
    });
  }

  async generateRateConfirmation(input: RateConfirmationPdfInput): Promise<Buffer> {
    return this.renderToBuffer((doc) => {
      doc.fontSize(18).text(`Rate Confirmation — Load ${input.loadNumber}`);
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`Carrier: ${input.carrierLegalName}`);
      doc.text(`Carrier Rate: ${input.carrierRate}`);
      doc.text(`Customer: ${input.customerLegalName}`);
      doc.text(`Equipment: ${input.equipmentType}`);
      doc.moveDown();
      doc.fontSize(14).text('Stops');
      doc.fontSize(12);
      for (const stop of [...input.stops].sort((a, b) => a.sequence - b.sequence)) {
        doc.text(`Stop ${stop.sequence} (${stop.stopType}): ${stop.city}, ${stop.state}`);
      }
    });
  }

  async generateInvoice(input: InvoicePdfInput): Promise<Buffer> {
    return this.renderToBuffer((doc) => {
      doc.fontSize(18).text(`Invoice ${input.invoiceNumber} — ${input.status}`);
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`Customer: ${input.customerLegalName}`);
      doc.text(`Total: ${input.total}`);
      doc.text(`Remaining Balance: ${input.remainingBalance}`);
      if (input.dueDate) doc.text(`Due Date: ${input.dueDate}`);
      doc.moveDown();
      doc.fontSize(14).text('Line Items');
      doc.fontSize(12);
      for (const item of input.lineItems) {
        doc.text(`${item.description}: ${item.amount}`);
      }
    });
  }

  async generateSettlement(input: SettlementPdfInput): Promise<Buffer> {
    return this.renderToBuffer((doc) => {
      doc.fontSize(18).text(`Carrier Settlement — Load ${input.loadNumber}`);
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`Carrier: ${input.carrierLegalName}`);
      doc.text(`Payment Type: ${input.paymentType}`);
      doc.text(`Amount: ${input.paymentAmount}`);
      doc.text(`Payment Date: ${input.paymentDate}`);
      if (input.method) doc.text(`Method: ${input.method}`);
      if (input.referenceNumber) doc.text(`Reference: ${input.referenceNumber}`);
    });
  }
}
