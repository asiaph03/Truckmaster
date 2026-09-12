import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { AppExceptionFilter } from './app-exception.filter';
import { RequestContextStore } from '../tenant-context/request-context';
import { NotFoundError } from '../errors/app-error';

function buildHost(
  method = 'GET',
  url = '/api/v1/loads/abc',
  overrides: { route?: { path: string }; path?: string } = {},
) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  // Mirrors HttpAccessLoggingMiddleware's spec convention: `path` defaults
  // to `url` with any query string stripped, since none of the existing
  // call sites below pass one — only the Phase 4A-19 query-string test
  // exercises a `url` that actually differs from `path`.
  const path = overrides.path ?? url.split('?')[0];
  const request = { method, url, path, route: overrides.route };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AppExceptionFilter — Monitoring Phase 4A-7 (org/user correlation on 5xx logs)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function runWithContext(
    context: { requestId: string; organizationId?: string; userId?: string } | undefined,
    fn: () => void,
  ) {
    if (context) {
      RequestContextStore.run(context, fn);
    } else {
      fn();
    }
  }

  it('a 5xx log includes org= and user= when organizationId/userId are present', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR);

    runWithContext({ requestId: 'req-1', organizationId: 'org-1', userId: 'user-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toContain('org=org-1');
    expect(message).toContain('user=user-1');
  });

  it('a 5xx log omits org=/user= cleanly (no undefined/null placeholders) when absent', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR);

    runWithContext({ requestId: 'req-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).not.toContain('org=');
    expect(message).not.toContain('user=');
    expect(message).not.toContain('undefined');
    expect(message).not.toContain('null');
  });

  it('a 5xx log still includes requestId when context is unavailable entirely', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR);

    filter.catch(exception, host);

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toContain('[no-request-id]');
    expect(message).not.toContain('org=');
    expect(message).not.toContain('user=');
  });

  it('requestId remains present in the log line alongside org=/user=', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR);

    runWithContext({ requestId: 'req-42', organizationId: 'org-9', userId: 'user-9' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toContain('[req-42]');
  });

  it('method, URL, and error message are preserved in the 5xx log line', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost('POST', '/api/v1/loads');
    const exception = new HttpException('something broke', HttpStatus.INTERNAL_SERVER_ERROR);

    runWithContext({ requestId: 'req-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toContain('POST');
    expect(message).toContain('/api/v1/loads');
    expect(message).toContain('something broke');
  });

  it('Monitoring Phase 4A-19 — logs errorType instead of the raw stack trace, with no second (trace) argument', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new Error('unexpected failure');

    runWithContext({ requestId: 'req-1', organizationId: 'org-1' }, () => {
      filter.catch(exception, host);
    });

    expect(errorLogSpy.mock.calls[0]).toHaveLength(1);
    expect(errorLogSpy.mock.calls[0][0]).toContain('errorType=Error');
  });

  it('non-5xx (4xx AppError) behavior is unchanged — no error-level log is emitted', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, status, json } = buildHost();
    const exception = new NotFoundError('Load not found.');

    runWithContext({ requestId: 'req-1', organizationId: 'org-1', userId: 'user-1' }, () => {
      filter.catch(exception, host);
    });

    expect(errorLogSpy).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'NOT_FOUND', message: 'Load not found.', details: undefined, requestId: 'req-1' },
    });
  });

  it('the response body still includes requestId regardless of org/user presence', () => {
    const filter = new AppExceptionFilter();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, json } = buildHost();
    const exception = new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR);

    runWithContext({ requestId: 'req-7' }, () => {
      filter.catch(exception, host);
    });

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ requestId: 'req-7' }) }),
    );
  });

  it('security/PII — the 5xx log never contains request/response bodies, headers, cookies, tokens, or the response error details object', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new HttpException(
      { message: 'boom', secret: 'should-not-appear', authorization: 'Bearer abc123' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );

    runWithContext({ requestId: 'req-1', organizationId: 'org-1', userId: 'user-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).not.toContain('should-not-appear');
    expect(message).not.toContain('Bearer');
    expect(message).not.toContain('authorization');
  });

  it('security/PII — org=/user= carry only the organizationId/userId values, never email/phone-shaped context fields', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR);

    runWithContext(
      { requestId: 'req-1', organizationId: 'org-uuid-1', userId: 'user-uuid-1' },
      () => {
        filter.catch(exception, host);
      },
    );

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toMatch(/org=org-uuid-1(\s|$)/);
    expect(message).toMatch(/user=user-uuid-1(\s|$)/);
    expect(message).not.toMatch(/@/);
  });
});

describe('AppExceptionFilter — Monitoring Phase 4A-19 (HTTP exception filter logging security)', () => {
  const SENSITIVE_MARKER = 'SENSITIVE_HTTP_ERROR_CONTENT';
  const SENSITIVE_QUERY_MARKER = 'SENSITIVE_QUERY_CONTENT';

  function runWithContext(
    context: { requestId: string; organizationId?: string; userId?: string } | undefined,
    fn: () => void,
  ) {
    if (context) {
      RequestContextStore.run(context, fn);
    } else {
      fn();
    }
  }

  function sensitiveError(): Error {
    return Object.assign(new Error(SENSITIVE_MARKER), {
      stack: `Error: ${SENSITIVE_MARKER}\n    at fake-stack (${SENSITIVE_MARKER})`,
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('SECURITY — a sensitive marker present in exception.message/.stack never appears in any Logger call', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AppExceptionFilter();
    const { host } = buildHost();
    const exception = sensitiveError();

    runWithContext({ requestId: 'req-1', organizationId: 'org-1' }, () => {
      filter.catch(exception, host);
    });

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('QUERY STRING — the normalized route is logged, but the raw query string and its content are never logged', () => {
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AppExceptionFilter();
    const { host } = buildHost('GET', `/api/v1/customers?search=${SENSITIVE_QUERY_MARKER}`, {
      route: { path: '/api/v1/customers' },
    });
    const exception = new Error('db lookup failed');

    runWithContext({ requestId: 'req-1', organizationId: 'org-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toContain('/api/v1/customers');
    expect(message).not.toContain(SENSITIVE_QUERY_MARKER);
    expect(message).not.toContain('?');
    expect(message).not.toContain('search=');
  });

  it('QUERY STRING — falls back to req.path (no query string) when req.route is unavailable (e.g. a genuine 404/unmatched route)', () => {
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AppExceptionFilter();
    const { host } = buildHost('GET', `/api/v1/documents?q=${SENSITIVE_QUERY_MARKER}`, {
      path: '/api/v1/documents',
    });
    const exception = new Error('unexpected failure');

    runWithContext({ requestId: 'req-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toContain('/api/v1/documents');
    expect(message).not.toContain(SENSITIVE_QUERY_MARKER);
    expect(message).not.toContain('?');
  });

  it('SAFE FORMAT — the log contains requestId, method, normalized route, org/user, and errorType', () => {
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AppExceptionFilter();
    const { host } = buildHost('POST', '/api/v1/loads/abc/documents', {
      route: { path: '/api/v1/loads/:id/documents' },
    });
    const exception = new Error('boom');

    runWithContext({ requestId: 'req-99', organizationId: 'org-1', userId: 'user-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).toContain('[req-99]');
    expect(message).toContain('POST');
    expect(message).toContain('/api/v1/loads/:id/documents');
    expect(message).toContain('org=org-1');
    expect(message).toContain('user=user-1');
    expect(message).toContain('errorType=Error');
  });

  it('SAFE FORMAT — never logs error.message/.stack/String(error)/JSON.stringify(error) for an uncaught non-AppError/non-HttpException', () => {
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AppExceptionFilter();
    const { host } = buildHost();
    const exception = sensitiveError();

    runWithContext({ requestId: 'req-1' }, () => {
      filter.catch(exception, host);
    });

    const [message] = errorLogSpy.mock.calls[0];
    expect(message).not.toContain(SENSITIVE_MARKER);
    expect(message).not.toContain(exception.stack);
    expect(message).not.toContain(String(exception));
    expect(message).toContain('errorType=Error');
  });

  it('RESPONSE REGRESSION — the client-facing JSON response is unchanged (code, message, details, requestId), unaffected by the logging change', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AppExceptionFilter();
    const { host, status, json } = buildHost('GET', '/api/v1/customers?search=irrelevant');
    const exception = new HttpException(
      { message: 'Something went wrong', extra: 'detail-value' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );

    runWithContext({ requestId: 'req-55', organizationId: 'org-1' }, () => {
      filter.catch(exception, host);
    });

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong',
        details: { message: 'Something went wrong', extra: 'detail-value' },
        requestId: 'req-55',
      },
    });
  });

  it('RESPONSE REGRESSION — an AppError (4xx) response body is unaffected by the logging change', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AppExceptionFilter();
    const { host, status, json } = buildHost();
    const exception = new NotFoundError('Load not found.');

    runWithContext({ requestId: 'req-1', organizationId: 'org-1' }, () => {
      filter.catch(exception, host);
    });

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'NOT_FOUND', message: 'Load not found.', details: undefined, requestId: 'req-1' },
    });
  });
});
