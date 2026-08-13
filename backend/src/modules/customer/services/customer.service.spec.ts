import { CustomerService } from './customer.service';
import { BusinessRuleError, ConflictError } from '../../../common/errors/app-error';

describe('CustomerService.create — Workflow 2', () => {
  const ORG_ID = 'org-1';
  const ACTING_USER = 'user-1';

  const DTO = {
    legalName: 'Acme Freight LLC',
    billingAddressLine1: '1 Main St',
    billingCity: 'Dallas',
    billingState: 'TX',
    billingZip: '75201',
    primaryContactName: 'Jane Booker',
    primaryContactEmail: 'jane@acme-freight.test',
    primaryContactPhone: '555-0100',
  };

  function buildService(opts: {
    defaultPaymentTerms?: string | null;
    existingCustomers?: Record<string, unknown>[];
  }) {
    const createdCustomer = { id: 'customer-1', legalName: DTO.legalName, status: 'PROSPECT' };

    const tx = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: ORG_ID,
          defaultPaymentTerms:
            opts.defaultPaymentTerms === undefined ? 'NET_30' : opts.defaultPaymentTerms,
        }),
      },
      customer: {
        findMany: jest.fn().mockResolvedValue(opts.existingCustomers ?? []),
        create: jest.fn().mockResolvedValue(createdCustomer),
      },
    };

    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CustomerService(prisma as never, audit as never);
    return { service, tx, audit };
  }

  describe('§2.3 — missing organization payment-terms configuration', () => {
    it('hard-blocks creation when the organization has no default payment terms', async () => {
      const { service, tx } = buildService({ defaultPaymentTerms: null });

      await expect(service.create(ORG_ID, DTO, ACTING_USER)).rejects.toThrow(BusinessRuleError);
      expect(tx.customer.create).not.toHaveBeenCalled();
    });
  });

  describe('§2.2 — duplicate detection (warning, not a hard block)', () => {
    it('blocks the first attempt with a 409 listing matches when a likely duplicate exists', async () => {
      const { service, tx } = buildService({
        existingCustomers: [
          {
            id: 'existing-1',
            legalName: 'ACME Freight, LLC.', // punctuation/case variant — normalized match
            billingAddressLine1: '1 Main St',
            billingCity: 'Dallas',
            billingState: 'TX',
            billingZip: '75201',
            primaryContactEmail: 'someone-else@acme-freight.test',
            contacts: [],
          },
        ],
      });

      await expect(service.create(ORG_ID, DTO, ACTING_USER)).rejects.toThrow(ConflictError);
      expect(tx.customer.create).not.toHaveBeenCalled();
    });

    it('proceeds and saves when the caller explicitly acknowledges the duplicate warning', async () => {
      const { service, tx } = buildService({
        existingCustomers: [
          {
            id: 'existing-1',
            legalName: 'Acme Freight LLC',
            billingAddressLine1: '999 Other Ave',
            billingCity: 'Austin',
            billingState: 'TX',
            billingZip: '73301',
            primaryContactEmail: 'other@example.test',
            contacts: [],
          },
        ],
      });

      await service.create(ORG_ID, { ...DTO, acknowledgeDuplicates: true }, ACTING_USER);

      expect(tx.customer.create).toHaveBeenCalled();
    });

    it("matches on primary contact email against another customer's additional contact, not just their primary", async () => {
      const { service, tx } = buildService({
        existingCustomers: [
          {
            id: 'existing-1',
            legalName: 'Totally Different Co',
            billingAddressLine1: '999 Other Ave',
            billingCity: 'Austin',
            billingState: 'TX',
            billingZip: '73301',
            primaryContactEmail: 'primary@different.test',
            contacts: [{ email: DTO.primaryContactEmail }],
          },
        ],
      });

      await expect(service.create(ORG_ID, DTO, ACTING_USER)).rejects.toThrow(ConflictError);
      expect(tx.customer.create).not.toHaveBeenCalled();
    });

    it('does not block when no customer matches on any signal', async () => {
      const { service, tx } = buildService({ existingCustomers: [] });

      await service.create(ORG_ID, DTO, ACTING_USER);

      expect(tx.customer.create).toHaveBeenCalled();
    });
  });

  describe('§2.1 — payment-term inheritance vs. override', () => {
    it('inherits Organization.defaultPaymentTerms when no override is provided', async () => {
      const { service, tx } = buildService({ defaultPaymentTerms: 'NET_45' });

      await service.create(ORG_ID, DTO, ACTING_USER);

      expect(tx.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentTerms: 'NET_45',
            paymentTermsSource: 'INHERITED',
          }),
        }),
      );
    });

    it('uses the override value and marks the source OVERRIDE when one is provided', async () => {
      const { service, tx } = buildService({ defaultPaymentTerms: 'NET_30' });

      await service.create(ORG_ID, { ...DTO, paymentTermsOverride: 'DUE_ON_RECEIPT' }, ACTING_USER);

      expect(tx.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentTerms: 'DUE_ON_RECEIPT',
            paymentTermsSource: 'OVERRIDE',
          }),
        }),
      );
    });
  });

  it('always creates a new Customer at status Prospect', async () => {
    const { service, tx } = buildService({});

    await service.create(ORG_ID, DTO, ACTING_USER);

    expect(tx.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROSPECT' }) }),
    );
  });
});
