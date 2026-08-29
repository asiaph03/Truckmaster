import ExcelJS from 'exceljs';
import { SpreadsheetService } from './spreadsheet.service';
import { ValidationError } from '../errors/app-error';

describe('SpreadsheetService', () => {
  const service = new SpreadsheetService();

  describe('parseCsv', () => {
    it('parses headers and rows, trimming whitespace', () => {
      const csv = 'Legal Name, City\nAcme Inc , Dallas \nBeta LLC,Chicago\n';
      const result = service.parseCsv(Buffer.from(csv, 'utf-8'));
      expect(result.headers).toEqual(['Legal Name', 'City']);
      expect(result.rows).toEqual([
        { 'Legal Name': 'Acme Inc', City: 'Dallas' },
        { 'Legal Name': 'Beta LLC', City: 'Chicago' },
      ]);
    });

    it('tolerates and strips a UTF-8 BOM (Decision 3)', () => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const csv = Buffer.concat([bom, Buffer.from('Legal Name\nAcme Inc\n', 'utf-8')]);
      const result = service.parseCsv(csv);
      expect(result.headers).toEqual(['Legal Name']);
      expect(result.rows).toEqual([{ 'Legal Name': 'Acme Inc' }]);
    });

    it('throws ValidationError for a file with no rows at all', () => {
      expect(() => service.parseCsv(Buffer.from('', 'utf-8'))).toThrow(ValidationError);
    });

    it('missing cells in a short row become empty strings, not undefined', () => {
      const csv = 'Legal Name,City\nAcme Inc\n';
      const result = service.parseCsv(Buffer.from(csv, 'utf-8'));
      expect(result.rows).toEqual([{ 'Legal Name': 'Acme Inc', City: '' }]);
    });
  });

  describe('parseXlsx', () => {
    async function buildWorkbookBuffer(rows: string[][]): Promise<Buffer> {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      rows.forEach((row) => sheet.addRow(row));
      const arrayBuffer = await workbook.xlsx.writeBuffer();
      return Buffer.from(arrayBuffer);
    }

    it('parses the first worksheet, row 1 as header (Decision 3)', async () => {
      const buffer = await buildWorkbookBuffer([
        ['Legal Name', 'City'],
        ['Acme Inc', 'Dallas'],
      ]);
      const result = await service.parseXlsx(buffer);
      expect(result.headers).toEqual(['Legal Name', 'City']);
      expect(result.rows).toEqual([{ 'Legal Name': 'Acme Inc', City: 'Dallas' }]);
    });

    it('throws ValidationError for an unparseable buffer', async () => {
      await expect(service.parseXlsx(Buffer.from('not an xlsx file'))).rejects.toThrow(
        ValidationError,
      );
    });
  });
});
