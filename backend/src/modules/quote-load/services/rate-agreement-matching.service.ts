import { Injectable } from '@nestjs/common';
import { EquipmentType, Prisma } from '@prisma/client';

export interface RateAgreementMatch {
  rateAgreementId: string;
  suggestedRate: Prisma.Decimal;
}

/** Case/punctuation-insensitive comparison, mirroring CustomerService's normalize(). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Workflow 4 §4.4 — Rate Agreement matching, shared by QuoteService and
 * LoadService so the lane+equipment matching logic exists in exactly one
 * place. Matches on the customer's *active* Rate Agreements
 * (effectiveDate <= today, expirationDate null or >= today) for the
 * origin/destination lane (city+state) and equipment type. "Origin" is
 * the first PICKUP stop by sequence; "destination" is the last DELIVERY
 * stop by sequence — CustomerRateAgreement models a single lane, not a
 * multi-stop route.
 */
@Injectable()
export class RateAgreementMatchingService {
  async findMatch(
    tx: Prisma.TransactionClient,
    organizationId: string,
    customerId: string,
    originCity: string,
    originState: string,
    destinationCity: string,
    destinationState: string,
    equipmentType: EquipmentType,
  ): Promise<RateAgreementMatch | null> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const candidates = await tx.customerRateAgreement.findMany({
      where: {
        organizationId,
        customerId,
        equipmentType,
        effectiveDate: { lte: today },
        OR: [{ expirationDate: null }, { expirationDate: { gte: today } }],
      },
    });

    const normalizedOriginCity = normalize(originCity);
    const normalizedOriginState = normalize(originState);
    const normalizedDestinationCity = normalize(destinationCity);
    const normalizedDestinationState = normalize(destinationState);

    const match = candidates.find(
      (candidate) =>
        normalize(candidate.originCity) === normalizedOriginCity &&
        normalize(candidate.originState) === normalizedOriginState &&
        normalize(candidate.destinationCity) === normalizedDestinationCity &&
        normalize(candidate.destinationState) === normalizedDestinationState,
    );

    if (!match) return null;
    return { rateAgreementId: match.id, suggestedRate: match.rate };
  }

  /**
   * Workflow 4 §4.4 steps 3a/3b, shared by QuoteService and LoadService.
   * `rateSource = RATE_AGREEMENT` when the submitted rate matches the
   * agreement's rate exactly (accepted as-is); `MANUAL_OVERRIDE` when a
   * match exists but the submitted rate differs (agreement id still
   * retained, never cleared); `MANUAL` when no agreement matches at all.
   */
  async resolveRate(
    tx: Prisma.TransactionClient,
    organizationId: string,
    customerId: string,
    originCity: string,
    originState: string,
    destinationCity: string,
    destinationState: string,
    equipmentType: EquipmentType,
    submittedRate: string,
  ): Promise<{
    rateAgreementId: string | null;
    rateSource: 'MANUAL' | 'RATE_AGREEMENT' | 'MANUAL_OVERRIDE';
  }> {
    const match = await this.findMatch(
      tx,
      organizationId,
      customerId,
      originCity,
      originState,
      destinationCity,
      destinationState,
      equipmentType,
    );
    if (!match) return { rateAgreementId: null, rateSource: 'MANUAL' };

    const acceptedAsIs = match.suggestedRate.equals(new Prisma.Decimal(submittedRate));
    return {
      rateAgreementId: match.rateAgreementId,
      rateSource: acceptedAsIs ? 'RATE_AGREEMENT' : 'MANUAL_OVERRIDE',
    };
  }
}
