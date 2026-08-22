/**
 * Phase 1 scaffolds the typed API client surface for every backend
 * module (§6 of the approved plan) so later phases don't redesign the
 * client layer per-feature, but only `auth.ts` has real implementations
 * — there are no screens yet to call the rest. Each stub throws so a
 * premature call fails loudly instead of silently returning nothing.
 */
export function notImplemented(name: string): never {
  throw new Error(
    `${name} is not implemented yet — this API client module is a Phase 1 typed stub.`,
  );
}
