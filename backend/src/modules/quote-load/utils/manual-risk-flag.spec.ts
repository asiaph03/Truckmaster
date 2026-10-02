import { evaluateManualRiskFlag } from './manual-risk-flag';

describe('evaluateManualRiskFlag — B.9 MANUAL_RISK_FLAG pure logic', () => {
  it('NORMAL never qualifies, even if a stale riskReason is somehow still present', () => {
    expect(evaluateManualRiskFlag({ riskStatus: 'NORMAL', riskReason: null })).toBeNull();
    expect(evaluateManualRiskFlag({ riskStatus: 'NORMAL', riskReason: 'leftover' })).toBeNull();
  });

  it('AT_RISK maps to MEDIUM', () => {
    const result = evaluateManualRiskFlag({ riskStatus: 'AT_RISK', riskReason: 'LATE' });
    expect(result).toEqual({ riskStatus: 'AT_RISK', reason: 'LATE', severity: 'MEDIUM' });
  });

  it('DELAYED maps to HIGH', () => {
    const result = evaluateManualRiskFlag({ riskStatus: 'DELAYED', riskReason: 'Traffic' });
    expect(result).toEqual({ riskStatus: 'DELAYED', reason: 'Traffic', severity: 'HIGH' });
  });

  it('never produces CRITICAL for any risk status', () => {
    for (const riskStatus of ['AT_RISK', 'DELAYED'] as const) {
      expect(evaluateManualRiskFlag({ riskStatus, riskReason: 'x' })!.severity).not.toBe(
        'CRITICAL',
      );
    }
  });

  it('copies riskReason verbatim — no trimming, truncation, or rewording', () => {
    const verbatim = "  Driver's reefer is not starting — 4h 23m away.  ";
    const result = evaluateManualRiskFlag({ riskStatus: 'AT_RISK', riskReason: verbatim });
    expect(result!.reason).toBe(verbatim);
  });

  it('defensively falls back to a generic sentence when riskReason is null', () => {
    expect(evaluateManualRiskFlag({ riskStatus: 'AT_RISK', riskReason: null })!.reason).toBe(
      'A dispatcher marked this load At Risk; no reason was recorded.',
    );
    expect(evaluateManualRiskFlag({ riskStatus: 'DELAYED', riskReason: null })!.reason).toBe(
      'A dispatcher marked this load Delayed; no reason was recorded.',
    );
  });

  it('defensively treats an empty or whitespace-only riskReason as missing', () => {
    for (const riskReason of ['', '   ', '\n\t']) {
      const result = evaluateManualRiskFlag({ riskStatus: 'AT_RISK', riskReason });
      expect(result!.reason).toBe('A dispatcher marked this load At Risk; no reason was recorded.');
      expect(result!.severity).toBe('MEDIUM');
    }
  });
});
