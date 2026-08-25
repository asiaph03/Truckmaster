import { toCsv } from './csv';

describe('toCsv', () => {
  it('joins fields with commas and rows with CRLF', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toBe('a,b\r\n1,2');
  });

  it('wraps a field containing a comma in quotes', () => {
    expect(toCsv([['Acme, Inc.', 'x']])).toBe('"Acme, Inc.",x');
  });

  it('wraps a field containing a newline in quotes', () => {
    expect(toCsv([['line one\nline two', 'x']])).toBe('"line one\nline two",x');
  });

  it('wraps a field containing a quote in quotes and doubles the internal quote', () => {
    expect(toCsv([['say "hi"', 'x']])).toBe('"say ""hi""",x');
  });

  it('leaves a plain field unquoted', () => {
    expect(toCsv([['plain', '123.45']])).toBe('plain,123.45');
  });

  it('renders an empty field as an empty string, not "null" or "undefined"', () => {
    expect(toCsv([['', 'x']])).toBe(',x');
  });
});
