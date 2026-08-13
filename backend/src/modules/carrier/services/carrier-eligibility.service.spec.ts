import { CarrierEligibilityService } from './carrier-eligibility.service';

/**
 * TECHNICAL_ARCHITECTURE.md §6.5 `computeEligibility` — table-driven
 * fixture tests per §16's testing strategy ("derived-field functions
 * against fixture inputs"), covering every one of the 7 locked
 * conditions independently plus the Blocked-carrier override.
 */
describe('CarrierEligibilityService', () => {
  const ORG_ID = 'org-1';
  const CARRIER_ID = 'carrier-1';

  const APPROVED_DOC = (code: string) => ({ documentType: { code }, reviewStatus: 'APPROVED' });
  const PENDING_DOC = (code: string) => ({
    documentType: { code },
    reviewStatus: 'PENDING_REVIEW',
  });

  const FUTURE_DATE = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
  const PAST_DATE = new Date(Date.now() - 1000 * 60 * 60 * 24);

  function fullyCompliantFixture() {
    return {
      carrier: {
        id: CARRIER_ID,
        organizationId: ORG_ID,
        status: 'ACTIVE',
        assignmentEligible: false,
      },
      documents: [
        APPROVED_DOC('CARRIER_AGREEMENT'),
        APPROVED_DOC('W9'),
        APPROVED_DOC('MC_AUTHORITY'),
      ],
      insurance: [
        {
          coverageType: 'AUTO_LIABILITY',
          expirationDate: FUTURE_DATE,
          coiDocument: { reviewStatus: 'APPROVED' },
        },
        {
          coverageType: 'CARGO',
          expirationDate: FUTURE_DATE,
          coiDocument: { reviewStatus: 'APPROVED' },
        },
      ],
      fmcsa: { resultStatus: 'Authorized', verificationDate: new Date() },
    };
  }

  function buildService(fixture: ReturnType<typeof fullyCompliantFixture>) {
    const tx = {
      carrier: {
        findFirstOrThrow: jest.fn().mockResolvedValue(fixture.carrier),
        update: jest.fn().mockResolvedValue(fixture.carrier),
      },
      document: { findMany: jest.fn().mockResolvedValue(fixture.documents) },
      carrierInsurance: { findMany: jest.fn().mockResolvedValue(fixture.insurance) },
      carrierFmcsaVerification: { findFirst: jest.fn().mockResolvedValue(fixture.fmcsa) },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CarrierEligibilityService(audit as never);
    return { service, tx, audit };
  }

  it('is eligible when all 7 conditions are satisfied', async () => {
    const fixture = fullyCompliantFixture();
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result).toEqual({ eligible: true, reasons: [] });
    expect(tx.carrier.update).toHaveBeenCalledWith({
      where: { id: CARRIER_ID },
      data: { assignmentEligible: true, ineligibilityReasons: [] },
    });
  });

  it('is ineligible with both reasons when the carrier is Blocked (independent checks, not if/else)', async () => {
    const fixture = fullyCompliantFixture();
    fixture.carrier.status = 'BLOCKED';
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Carrier is Blocked');
    expect(result.reasons).toContain('Carrier status is not Active');
  });

  it('is ineligible when the carrier is Pending (not yet Active)', async () => {
    const fixture = fullyCompliantFixture();
    fixture.carrier.status = 'PENDING';
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['Carrier status is not Active']);
  });

  it('is ineligible when the Carrier Agreement is missing', async () => {
    const fixture = fullyCompliantFixture();
    fixture.documents = fixture.documents.filter(
      (d) => d.documentType.code !== 'CARRIER_AGREEMENT',
    );
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Carrier Agreement is not approved');
  });

  it('is ineligible when the W9 is pending review rather than approved', async () => {
    const fixture = fullyCompliantFixture();
    fixture.documents = fixture.documents.map((d) =>
      d.documentType.code === 'W9' ? PENDING_DOC('W9') : d,
    );
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.reasons).toContain('W9 is not approved');
  });

  it('is ineligible when MC Authority is not approved', async () => {
    const fixture = fullyCompliantFixture();
    fixture.documents = fixture.documents.map((d) =>
      d.documentType.code === 'MC_AUTHORITY' ? PENDING_DOC('MC_AUTHORITY') : d,
    );
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.reasons).toContain('MC Authority is not approved');
  });

  it('is ineligible when Auto Liability insurance is expired', async () => {
    const fixture = fullyCompliantFixture();
    fixture.insurance = fixture.insurance.map((i) =>
      i.coverageType === 'AUTO_LIABILITY' ? { ...i, expirationDate: PAST_DATE } : i,
    );
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.reasons).toContain('Auto Liability insurance is expired or not approved');
  });

  it('is ineligible when Cargo insurance exists but its COI document is not approved', async () => {
    const fixture = fullyCompliantFixture();
    fixture.insurance = fixture.insurance.map((i) =>
      i.coverageType === 'CARGO' ? { ...i, coiDocument: { reviewStatus: 'PENDING_REVIEW' } } : i,
    );
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.reasons).toContain('Cargo insurance is expired or not approved');
  });

  it('is ineligible when no FMCSA verification exists', async () => {
    const fixture = fullyCompliantFixture();
    fixture.fmcsa = null as never;
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.reasons).toContain('FMCSA/SAFER verification is missing or not acceptable');
  });

  it('is ineligible when the latest FMCSA verification result is "Not Authorized"', async () => {
    const fixture = fullyCompliantFixture();
    fixture.fmcsa = { resultStatus: 'Not Authorized', verificationDate: new Date() };
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.reasons).toContain('FMCSA/SAFER verification is missing or not acceptable');
  });

  it('accepts "Authorized" case-insensitively', async () => {
    const fixture = fullyCompliantFixture();
    fixture.fmcsa = { resultStatus: '  authorized  ', verificationDate: new Date() };
    const { service, tx } = buildService(fixture);

    const result = await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(result.reasons).not.toContain('FMCSA/SAFER verification is missing or not acceptable');
  });

  it('records "Assignment Eligibility Changed" only when eligibility actually flips', async () => {
    const fixture = fullyCompliantFixture();
    fixture.carrier.assignmentEligible = false;
    const { service, tx, audit } = buildService(fixture);

    await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'Assignment Eligibility Changed' }),
    );
  });

  it('does not record an audit event when eligibility stays the same across a recalculation', async () => {
    const fixture = fullyCompliantFixture();
    fixture.carrier.assignmentEligible = true; // already eligible, and stays eligible
    const { service, tx, audit } = buildService(fixture);

    await service.recalculate(tx as never, ORG_ID, CARRIER_ID);

    expect(audit.record).not.toHaveBeenCalled();
  });

  describe('checkActivationReadiness', () => {
    it('is ready when the 6 compliance conditions hold, even though status is still Pending', async () => {
      const fixture = fullyCompliantFixture();
      fixture.carrier.status = 'PENDING'; // the pre-activation reality
      const { service, tx } = buildService(fixture);

      const result = await service.checkActivationReadiness(tx as never, ORG_ID, CARRIER_ID);

      expect(result).toEqual({ eligible: true, reasons: [] });
      // Activation readiness must never read/update the carrier row itself
      // (no status-flip side effect) — only recalculate() does that.
      expect(tx.carrier.findFirstOrThrow).not.toHaveBeenCalled();
      expect(tx.carrier.update).not.toHaveBeenCalled();
    });

    it('blocks activation when a compliance condition is unmet', async () => {
      const fixture = fullyCompliantFixture();
      fixture.carrier.status = 'PENDING';
      fixture.documents = fixture.documents.filter((d) => d.documentType.code !== 'W9');
      const { service, tx } = buildService(fixture);

      const result = await service.checkActivationReadiness(tx as never, ORG_ID, CARRIER_ID);

      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('W9 is not approved');
    });
  });
});
