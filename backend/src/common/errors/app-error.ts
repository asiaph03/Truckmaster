/**
 * Typed error hierarchy per TECHNICAL_ARCHITECTURE.md §2.7. Every service-
 * layer business-rule failure throws one of these (never a bare `Error`
 * or a NestJS `HttpException` directly from a service) so the global
 * `AppExceptionFilter` (common/filters/app-exception.filter.ts) can map it
 * to the consistent `{ error: { code, message, details } }` response
 * shape the frontend keys its error-state UI off (UI_UX_DESIGN.md §5.5.3
 * — by `code`, never message text).
 */
export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — malformed/incomplete input caught outside the DTO validation pipe. */
export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly code = 'VALIDATION_ERROR';
}

/** 401 — no/invalid/expired session. */
export class AuthenticationError extends AppError {
  readonly httpStatus = 401;
  readonly code = 'AUTHENTICATION_ERROR';
}

/** 403 — the acting role never has permission for this action (§7 matrix blank cell). */
export class PermissionError extends AppError {
  readonly httpStatus = 403;
  readonly code = 'PERMISSION_ERROR';
}

/**
 * 403 — the specific self-review/self-approval prevention rule (Workflow 3
 * §3.4, Workflow 9 §9.4). Distinct code from PermissionError because the
 * acting role *does* generally have the permission — it's specifically
 * blocked from applying it to their own prior action.
 */
export class SelfReviewForbiddenError extends AppError {
  readonly httpStatus = 403;
  readonly code = 'SELF_REVIEW_FORBIDDEN';
}

/** 404 — not found, including "exists but not in the caller's organization" (§3.5). */
export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = 'NOT_FOUND';
}

/** 409 — attempted an illegal state-machine transition (§6). */
export class InvalidTransitionError extends AppError {
  readonly httpStatus = 409;
  readonly code = 'INVALID_TRANSITION';
}

/** 409 — a hard eligibility gate failed (e.g. Workflow 5 §5.3 carrier eligibility). */
export class EligibilityError extends AppError {
  readonly httpStatus = 409;
  readonly code = 'ELIGIBILITY_ERROR';
}

/** 409 — a general conflict not covered by the more specific 409 types above. */
export class ConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = 'CONFLICT';
}

/** 422 — well-formed and currently-legal, but violates a business rule (missing required reason, etc.). */
export class BusinessRuleError extends AppError {
  readonly httpStatus = 422;
  readonly code = 'BUSINESS_RULE_ERROR';
}
