import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escapeHtml';

describe('escapeHtml — Dashboard Map Phase popup safety', () => {
  it('escapes a script-injection attempt in a free-text field (e.g. Truck Number)', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes quotes so an injected attribute cannot break out of a popup HTML string', () => {
    expect(escapeHtml(`"><script>alert(1)</script>`)).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeHtml('Jane Driver')).toBe('Jane Driver');
  });
});
