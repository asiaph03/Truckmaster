import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { ValidationError } from '../errors/app-error';

export interface ParsedSpreadsheet {
  headers: string[];
  /** Each row is header-cell-text -> raw string value, row 1 (header) excluded. */
  rows: Record<string, string>[];
}

/**
 * Bulk Import (PRD.md §1.4, §6.9, §10.1, §13) — read-side only. Shared with
 * a future Excel Export phase's write-side by design (same module), but
 * this phase adds only the parsing functionality actually required now
 * (approved technical design, Decision 8) — no writeXlsx()/export code.
 *
 * CSV: UTF-8 with BOM tolerated/stripped (approved defaults, Decision 3).
 * XLSX: first worksheet only, row 1 treated as the header row.
 */
@Injectable()
export class SpreadsheetService {
  parseCsv(buffer: Buffer): ParsedSpreadsheet {
    const text = buffer.toString('utf-8').replace(/^﻿/, '');
    let records: string[][];
    try {
      records = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
    } catch (error) {
      throw new ValidationError(
        `Could not parse CSV file: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    return this.toParsedSpreadsheet(records);
  }

  async parseXlsx(buffer: Buffer): Promise<ParsedSpreadsheet> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch (error) {
      throw new ValidationError(
        `Could not parse Excel file: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new ValidationError('The Excel file has no worksheets.');
    }

    const records: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as (ExcelJS.CellValue | undefined)[];
      // ExcelJS's row.values is 1-indexed with a leading undefined at [0].
      const cells = values.slice(1).map((v) => this.cellToString(v));
      records.push(cells);
    });
    return this.toParsedSpreadsheet(records);
  }

  private cellToString(value: ExcelJS.CellValue | undefined): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object' && 'text' in value)
      return String((value as { text: unknown }).text ?? '');
    if (typeof value === 'object' && 'result' in value)
      return String((value as { result: unknown }).result ?? '');
    return String(value);
  }

  private toParsedSpreadsheet(records: string[][]): ParsedSpreadsheet {
    if (records.length === 0) {
      throw new ValidationError('The file has no rows — a header row is required.');
    }
    const headers = records[0].map((h) => h.trim());
    if (headers.every((h) => h.length === 0)) {
      throw new ValidationError('The file has no detectable header row.');
    }
    const rows = records.slice(1).map((record) => {
      const row: Record<string, string> = {};
      headers.forEach((header, i) => {
        row[header] = (record[i] ?? '').toString().trim();
      });
      return row;
    });
    return { headers, rows };
  }
}
