import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { RateConfirmationDropzone } from './RateConfirmationDropzone';
import type { ExtractedRateConfirmationData } from '../../api/rateConfirmationExtraction';

function pdfFile(name = 'ratecon.pdf') {
  return new File(['%PDF-1.4 fake'], name, { type: 'application/pdf' });
}

function fileInput() {
  return document.querySelector('.rate-confirmation-dropzone-input') as HTMLInputElement;
}

describe('RateConfirmationDropzone — Rate Confirmation extraction feature', () => {
  it('rejects a non-PDF file client-side, before any request is made', () => {
    let requestCount = 0;
    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () => {
        requestCount += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    render(<RateConfirmationDropzone onExtracted={() => {}} />);
    const file = new File(['not a pdf'], 'ratecon.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(screen.getByText('Only PDF files are supported.')).toBeInTheDocument();
    expect(requestCount).toBe(0);
  });

  it('rejects a file over 20MB client-side, before any request is made', () => {
    let requestCount = 0;
    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () => {
        requestCount += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    render(<RateConfirmationDropzone onExtracted={() => {}} />);
    const oversized = new File([new Uint8Array(21 * 1024 * 1024)], 'huge.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(fileInput(), { target: { files: [oversized] } });

    expect(screen.getByText(/maximum size is 20 MB/)).toBeInTheDocument();
    expect(requestCount).toBe(0);
  });

  it('drives through uploading -> scanning -> extracting -> complete and calls onExtracted exactly once', async () => {
    const extraction: ExtractedRateConfirmationData = {
      customer: null,
      equipmentType: 'DRY_VAN',
      customerRate: '1500.00',
      customerPoNumber: null,
      bolNumber: null,
      pickupNumber: null,
      customerReferenceNumber: null,
      stops: [],
      warnings: [],
      unmappedFields: [],
    };

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
          data: extraction,
        }),
      ),
    );

    let received: ExtractedRateConfirmationData | undefined;
    render(<RateConfirmationDropzone onExtracted={(d) => (received = d)} />);

    fireEvent.change(fileInput(), { target: { files: [pdfFile()] } });

    await waitFor(() => expect(screen.getByText('Extracted — review below')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(received).toEqual(extraction);
  });

  it('a SCAN_FAILED scan result proceeds to extraction rather than becoming a terminal error (approved policy: only INFECTED blocks)', async () => {
    const extraction: ExtractedRateConfirmationData = {
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
    };

    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () =>
        HttpResponse.json(
          { extractionId: 'ex-sf', uploadUrl: 'https://fake-upload.test/put-sf' },
          { status: 201 },
        ),
      ),
      http.put('https://fake-upload.test/put-sf', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/rate-confirmation-extractions/ex-sf/confirm', () =>
        HttpResponse.json({ extractionId: 'ex-sf', scanStatus: 'PENDING' }),
      ),
      http.get('/api/v1/rate-confirmation-extractions/ex-sf', () =>
        HttpResponse.json({
          extractionId: 'ex-sf',
          scanStatus: 'SCAN_FAILED',
          extractionStatus: 'COMPLETE',
          extractionError: null,
          data: extraction,
        }),
      ),
    );

    let received: ExtractedRateConfirmationData | undefined;
    render(<RateConfirmationDropzone onExtracted={(d) => (received = d)} />);
    fireEvent.change(fileInput(), { target: { files: [pdfFile()] } });

    await waitFor(() => expect(screen.getByText('Extracted — review below')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(received).toEqual(extraction);
    expect(
      screen.queryByText('This file was flagged by malware scanning and cannot be used.'),
    ).not.toBeInTheDocument();
  });

  it('surfaces an INFECTED scan result as an error, never reaches extraction', async () => {
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
          scanStatus: 'INFECTED',
          extractionStatus: 'NOT_STARTED',
          extractionError: null,
          data: null,
        }),
      ),
    );

    let extractedCalled = false;
    render(<RateConfirmationDropzone onExtracted={() => (extractedCalled = true)} />);
    fireEvent.change(fileInput(), { target: { files: [pdfFile()] } });

    await waitFor(
      () =>
        expect(
          screen.getByText('This file was flagged by malware scanning and cannot be used.'),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(extractedCalled).toBe(false);
  });

  it('a FAILED extraction shows the error and a Retry action that re-runs extraction without re-uploading', async () => {
    let confirmCalls = 0;
    let retryCalls = 0;

    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () =>
        HttpResponse.json(
          { extractionId: 'ex-3', uploadUrl: 'https://fake-upload.test/put3' },
          { status: 201 },
        ),
      ),
      http.put('https://fake-upload.test/put3', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/rate-confirmation-extractions/ex-3/confirm', () => {
        confirmCalls += 1;
        return HttpResponse.json({ extractionId: 'ex-3', scanStatus: 'PENDING' });
      }),
      http.post('/api/v1/rate-confirmation-extractions/ex-3/retry', () => {
        retryCalls += 1;
        return HttpResponse.json({ extractionId: 'ex-3', extractionStatus: 'PENDING' });
      }),
      http.get('/api/v1/rate-confirmation-extractions/ex-3', () => {
        // First poll: extraction FAILED (multi-load detection message).
        // After retry, subsequent polls report COMPLETE.
        if (retryCalls === 0) {
          return HttpResponse.json({
            extractionId: 'ex-3',
            scanStatus: 'CLEAN',
            extractionStatus: 'FAILED',
            extractionError:
              'This Rate Confirmation appears to contain multiple loads. Please upload one Rate Confirmation for a single load.',
            data: null,
          });
        }
        return HttpResponse.json({
          extractionId: 'ex-3',
          scanStatus: 'CLEAN',
          extractionStatus: 'COMPLETE',
          extractionError: null,
          data: {
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
          },
        });
      }),
    );

    render(<RateConfirmationDropzone onExtracted={() => {}} />);
    fireEvent.change(fileInput(), { target: { files: [pdfFile()] } });

    await waitFor(
      () => expect(screen.getByText(/appears to contain multiple loads/)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(confirmCalls).toBe(1);

    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getByText('Extracted — review below')).toBeInTheDocument(), {
      timeout: 5000,
    });
    // Retry never re-uploads/re-confirms — only re-enqueues extraction.
    expect(confirmCalls).toBe(1);
    expect(retryCalls).toBe(1);
  });

  it('Remove clears the current file/state so a different one can be chosen', async () => {
    server.use(
      http.post('/api/v1/rate-confirmation-extractions', () =>
        HttpResponse.json(
          { extractionId: 'ex-4', uploadUrl: 'https://fake-upload.test/put4' },
          { status: 201 },
        ),
      ),
      http.put('https://fake-upload.test/put4', () => new HttpResponse(null, { status: 200 })),
      http.post('/api/v1/rate-confirmation-extractions/ex-4/confirm', () =>
        HttpResponse.json({ extractionId: 'ex-4', scanStatus: 'PENDING' }),
      ),
      http.get('/api/v1/rate-confirmation-extractions/ex-4', () =>
        HttpResponse.json({
          extractionId: 'ex-4',
          scanStatus: 'CLEAN',
          extractionStatus: 'COMPLETE',
          extractionError: null,
          data: {
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
          },
        }),
      ),
    );

    render(<RateConfirmationDropzone onExtracted={() => {}} />);
    fireEvent.change(fileInput(), { target: { files: [pdfFile('first.pdf')] } });
    await waitFor(() => expect(screen.getByText('Extracted — review below')).toBeInTheDocument(), {
      timeout: 5000,
    });

    fireEvent.click(screen.getByText('Remove'));

    expect(screen.getByText('Drag & drop your Rate Confirmation PDF here')).toBeInTheDocument();
    expect(screen.queryByText('first.pdf')).not.toBeInTheDocument();
  });
});
