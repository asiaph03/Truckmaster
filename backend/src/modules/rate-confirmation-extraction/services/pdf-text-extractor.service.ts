import { Injectable, Logger } from '@nestjs/common';

export interface PdfTextExtractionResult {
  /** Concatenated text content across all pages, in page order, with real line breaks preserved (see extractText's doc comment). Empty string if the PDF has no embedded text layer at all (scanned/faxed/image-only). */
  text: string;
  pageCount: number;
  /** True once any page yielded non-whitespace text — the signal for whether local field extraction can proceed at all. False means the document has no usable text layer (scanned/image-only or corrupt) and extraction must fail with a clear, user-facing error rather than guessing. */
  hasTextLayer: boolean;
}

/** Two text items are treated as being on the same visual line when their baseline y-coordinates differ by no more than this many PDF units. */
const LINE_Y_TOLERANCE = 2;

/**
 * Rate Confirmation → New Load auto-populate feature — local, no-external-
 * call, no-AI text extraction from a PDF's embedded text layer. This is
 * the ONLY extraction mechanism in the feature: PDFs without a usable
 * text layer (scanned/faxed/image-only) are not supported — no OCR, no
 * vision model, no other fallback. `LocalRateConfirmationExtractor` treats
 * `hasTextLayer: false` as a hard failure with a clear, user-facing error.
 *
 * `pdfjs-dist` is ESM-only (`main: "build/pdf.mjs"`, no CJS export) while
 * this backend compiles to CommonJS (tsconfig.json `module: "commonjs"`)
 * — a dynamic `import()` is required rather than a static import, exactly
 * the standard, supported way to load an ESM package from CommonJS.
 *
 * pdfjs's raw `getTextContent()` items are NOT reliably in reading order
 * and carry no line breaks — for an LLM that didn't matter (it could
 * still make sense of a jumbled page), but the local, regex-based field
 * parser (`LocalRateConfirmationExtractor`) depends on real row
 * structure (e.g. "company name on one line, street address on the
 * next"). Items are therefore grouped into visual lines by their PDF
 * baseline y-coordinate (`item.transform[5]`, tolerance `LINE_Y_TOLERANCE`),
 * each line's items ordered left-to-right by x-coordinate
 * (`item.transform[4]`), and lines emitted top-to-bottom per page.
 */
@Injectable()
export class PdfTextExtractorService {
  private readonly logger = new Logger(PdfTextExtractorService.name);

  async extractText(pdfBytes: Buffer): Promise<PdfTextExtractionResult> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBytes),
      useSystemFonts: true,
    });

    let document: Awaited<typeof loadingTask.promise> | undefined;
    try {
      document = await loadingTask.promise;

      let fullText = '';
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        fullText += `${linesFromTextContentItems(content.items)}\n`;
        page.cleanup();
      }

      const text = fullText.trim();
      return { text, pageCount: document.numPages, hasTextLayer: text.length > 0 };
    } catch (error) {
      // Never log the PDF's own content — file size/page count only.
      this.logger.warn(
        `PDF text extraction failed (${pdfBytes.length} bytes) — this document has no usable text layer: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { text: '', pageCount: 0, hasTextLayer: false };
    } finally {
      // destroy() lives on the loading task, not the resolved document
      // proxy (PDFDocumentProxy only exposes cleanup()) — this tears
      // down the whole task/worker regardless of whether .promise
      // resolved or rejected above.
      await loadingTask.destroy();
    }
  }
}

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
}

function linesFromTextContentItems(items: unknown[]): string {
  const positioned: PositionedTextItem[] = items
    .filter(
      (item): item is { str: string; transform: number[] } =>
        typeof item === 'object' &&
        item !== null &&
        'str' in item &&
        'transform' in item &&
        typeof (item as { str: unknown }).str === 'string',
    )
    .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5] }))
    .filter((item) => item.str.trim().length > 0);

  // Top-to-bottom (descending y — PDF's y-axis increases upward), then
  // left-to-right within whatever line grouping follows.
  positioned.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: string[] = [];
  let currentLineY: number | null = null;
  let currentLineParts: string[] = [];

  for (const item of positioned) {
    if (currentLineY === null || Math.abs(item.y - currentLineY) > LINE_Y_TOLERANCE) {
      if (currentLineParts.length > 0) lines.push(currentLineParts.join(' ').trim());
      currentLineParts = [];
      currentLineY = item.y;
    }
    currentLineParts.push(item.str);
  }
  if (currentLineParts.length > 0) lines.push(currentLineParts.join(' ').trim());

  return lines.join('\n');
}
