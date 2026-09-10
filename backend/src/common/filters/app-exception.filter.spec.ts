import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { AppExceptionFilter } from './app-exception.filter';
import { RequestContextStore } from '../tenant-context/request-context';
import { NotFoundError } from '../errors/app-error';

function buildHost(method = 'GET', url = '/api/v1/loads/abc') {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { method, url };

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

  it('the stack trace argument is still passed through unchanged for a real Error', () => {
    const filter = new AppExceptionFilter();
    const errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = buildHost();
    const exception = new Error('unexpected failure');

    runWithContext({ requestId: 'req-1', organizationId: 'org-1' }, () => {
      filter.catch(exception, host);
    });

    const [, stack] = errorLogSpy.mock.calls[0];
    expect(stack).toBe(exception.stack);
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
