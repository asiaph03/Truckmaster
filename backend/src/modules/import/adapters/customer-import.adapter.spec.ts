import { CustomerImportAdapter } from './customer-import.adapter';
import { ImportDuplicateCache } from './types';

describe('CustomerImportAdapter', () => {
  function buildAdapter() {
    const existingCustomer = {
      id: 'existing-1',
      legalName: 'Acme Inc',
      billingAddressLine1: '1 Main St',
      billingCity: 'Dallas',
      billingState: 'TX',
      billingZip: '75201',
      primaryContactEmail: 'contact@acme.com',
      contacts: [],
    };
    const customerService = {
      fetchDuplicateCandidatesForOrg: jest.fn().mockResolvedValue([existingCustomer]),
      matchDuplicates: jest.fn((dto, candidates) => {
        // Mirrors the real normalize()-based comparison closely enough for
        // this adapter-level test: exact-legal-name match only.
        return candidates
          .filter(
            (c: { legalName: string }) => c.legalName.toLowerCase() === dto.legalName.toLowerCase(),
          )
          .map((c: { id: string; legalName: string }) => ({
            customerId: c.id,
            legalName: c.legalName,
            matchedOn: ['legalName'],
          }));
      }),
      create: jest.fn().mockResolvedValue({
        id: 'new-1',
        legalName: 'Acme Inc',
        billingAddressLine1: '2 Other St',
        billingCity: 'Austin',
        billingState: 'TX',
        billingZip: '73301',
        primaryContactEmail: 'new@acme.com',
      }),
    };
    const adapter = new CustomerImportAdapter(customerService as never);
    return { adapter, customerService, existingCustomer };
  }

  it('mapRow rejects a row missing a required field', async () => {
    const { adapter } = buildAdapter();
    const result = await adapter.mapRow({ legalName: '' });
    expect(result.dto).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('checkBusinessRules preloads candidates once and reports a duplicate warning', async () => {
    const { adapter, customerService } = buildAdapter();
    const cache: ImportDuplicateCache = {};
    const dto = {
      legalName: 'Acme Inc',
      billingAddressLine1: 'x',
      billingCity: 'x',
      billingState: 'x',
      billingZip: 'x',
      primaryContactName: 'x',
      primaryContactEmail: 'x@example.com',
      primaryContactPhone: 'x',
    };

    const result1 = await adapter.checkBusinessRules('org-1', dto, cache);
    const result2 = await adapter.checkBusinessRules('org-1', dto, cache);

    expect(customerService.fetchDuplicateCandidatesForOrg).toHaveBeenCalledTimes(1);
    expect(result1.duplicateWarning).toHaveLength(1);
    expect(result2.duplicateWarning).toHaveLength(1);
  });

  it('commit passes the preloaded cache to CustomerService.create and grows it with the new customer (intra-batch duplicate detection)', async () => {
    const { adapter, customerService, existingCustomer } = buildAdapter();
    const cache: ImportDuplicateCache = {
      customerCandidates: [
        existingCustomer,
      ] as unknown as ImportDuplicateCache['customerCandidates'],
    };
    const dto = {
      legalName: 'Acme Inc',
      billingAddressLine1: '2 Other St',
      billingCity: 'Austin',
      billingState: 'TX',
      billingZip: '73301',
      primaryContactName: 'x',
      primaryContactEmail: 'new@acme.com',
      primaryContactPhone: 'x',
    };

    await adapter.commit('org-1', dto, 'user-1', undefined, true, cache);

    // Note: `create` is called with the *same* array reference the code
    // then pushes onto — jest's toHaveBeenCalledWith reflects the array's
    // current (post-push) contents, not a snapshot at call time, so this
    // asserts identity/shape rather than exact pre-push contents.
    expect(customerService.create).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ acknowledgeDuplicates: true }),
      'user-1',
      cache.customerCandidates,
    );
    expect(customerService.create.mock.calls[0][3]).toContainEqual(existingCustomer);
    expect(cache.customerCandidates).toHaveLength(2);
    expect(cache.customerCandidates?.[1].id).toBe('new-1');
  });
});
