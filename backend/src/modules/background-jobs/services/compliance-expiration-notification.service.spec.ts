import { ComplianceExpirationNotificationService } from './compliance-expiration-notification.service';

const ORG_ID = 'org-1';

const EXPIRING_DOC = {
  id: 'doc-1',
  entityId: 'carrier-1',
  expirationDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
  documentType: { label: 'MC Authority' },
};

const EXPIRING_INSURANCE = {
  id: 'ins-1',
  carrierId: 'carrier-1',
  coverageType: 'CARGO',
  expirationDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
};

function buildService(
  opts: {
    docs?: Record<string, unknown>[];
    insurance?: Record<string, unknown>[];
    alreadyNotified?: boolean;
  } = {},
) {
  const tx = {
    document: { findMany: jest.fn().mockResolvedValue(opts.docs ?? []) },
    carrierInsurance: { findMany: jest.fn().mockResolvedValue(opts.insurance ?? []) },
    carrier: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'carrier-1',
        legalName: 'Acme Trucking',
        assignmentEligible: true,
      }),
    },
    notification: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.alreadyNotified ? { id: 'existing-notif' } : null),
    },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { createForRoles: jest.fn().mockResolvedValue(undefined) };

  const service = new ComplianceExpirationNotificationService(
    prisma as never,
    audit as never,
    notifications as never,
  );
  return { service, tx, audit, notifications, prisma };
}

describe('ComplianceExpirationNotificationService — Workflow 3 §3.10', () => {
  it('notifies Operations Manager/Compliance Reviewer for a document expiring within a threshold window', async () => {
    const { service, notifications, audit } = buildService({ docs: [EXPIRING_DOC] });

    await service.run();

    expect(notifications.createForRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      ['OPERATIONS_MANAGER', 'COMPLIANCE_REVIEWER'],
      expect.objectContaining({ relatedEntityType: 'Document', relatedEntityId: 'doc-1' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Expiration Notification Sent' }),
    );
  });

  it('notifies for an insurance record expiring within a threshold window', async () => {
    const { service, notifications } = buildService({ insurance: [EXPIRING_INSURANCE] });

    await service.run();

    expect(notifications.createForRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      ['OPERATIONS_MANAGER', 'COMPLIANCE_REVIEWER'],
      expect.objectContaining({ relatedEntityType: 'CarrierInsurance', relatedEntityId: 'ins-1' }),
    );
  });

  it('"each fires once" — skips an item that already has a Notification for this threshold', async () => {
    const { service, notifications } = buildService({
      docs: [EXPIRING_DOC],
      alreadyNotified: true,
    });

    await service.run();

    expect(notifications.createForRoles).not.toHaveBeenCalled();
  });
});
