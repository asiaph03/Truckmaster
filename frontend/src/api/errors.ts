/**
 * Mirrors the global exception filter's JSON error shape
 * (backend/src/common/filters/app-exception.filter.ts) and its fixed
 * `AppError` code set. Frontend error handling keys off `code`, never
 * `message` — matching the inline comment in that filter referencing
 * UI_UX_DESIGN.md §5.5.3.
 */
export const APP_ERROR_CODES = [
  'VALIDATION_ERROR',
  'AUTHENTICATION_ERROR',
  'PERMISSION_ERROR',
  'SELF_REVIEW_FORBIDDEN',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'ELIGIBILITY_ERROR',
  'CONFLICT',
  'POD_INCOMPLETE_WARNING',
  'BUSINESS_RULE_ERROR',
] as const;
// "widen a literal union but keep autocomplete" idiom, not an accidental {}.
// eslint-disable-next-line @typescript-eslint/ban-types
export type AppErrorCode = (typeof APP_ERROR_CODES)[number] | 'INTERNAL_ERROR' | (string & {});

export interface ApiErrorBody {
  code: AppErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

export function isAuthenticationError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'AUTHENTICATION_ERROR';
}

export function isPermissionError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'PERMISSION_ERROR';
}
