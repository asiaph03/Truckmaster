// Beta Launch Hardening — disables the real rate limiter for e2e runs by
// default (see app.module.ts's ThrottlerModule `skipIf`). Every e2e file
// except security.e2e-spec.ts logs in many times per run as an ordinary
// part of testing unrelated business logic, not the limiter itself;
// security.e2e-spec.ts explicitly flips this back to 'false' around its
// own tests so the real limiter is genuinely exercised there. Runs once,
// before any test file's imports, via Jest's `setupFiles`.
process.env.DISABLE_RATE_LIMIT_FOR_TESTS = 'true';
