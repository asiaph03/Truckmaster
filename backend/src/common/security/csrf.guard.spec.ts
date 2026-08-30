import { ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';
import { CsrfError } from '../errors/app-error';

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();

  function contextFor(
    method: string,
    cookies: Record<string, string>,
    headers: Record<string, string>,
  ) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, cookies, headers }),
      }),
    } as unknown as ExecutionContext;
  }

  it('allows a GET request through with no cookie or header at all (safe method)', () => {
    expect(guard.canActivate(contextFor('GET', {}, {}))).toBe(true);
  });

  it('allows HEAD and OPTIONS through too', () => {
    expect(guard.canActivate(contextFor('HEAD', {}, {}))).toBe(true);
    expect(guard.canActivate(contextFor('OPTIONS', {}, {}))).toBe(true);
  });

  it('allows a POST through when the cookie and header match', () => {
    expect(
      guard.canActivate(contextFor('POST', { csrf_token: 'abc123' }, { 'x-csrf-token': 'abc123' })),
    ).toBe(true);
  });

  it('rejects a POST with no cookie at all', () => {
    expect(() => guard.canActivate(contextFor('POST', {}, { 'x-csrf-token': 'abc123' }))).toThrow(
      CsrfError,
    );
  });

  it('rejects a POST with no header at all', () => {
    expect(() => guard.canActivate(contextFor('POST', { csrf_token: 'abc123' }, {}))).toThrow(
      CsrfError,
    );
  });

  it('rejects a POST where the cookie and header values do not match', () => {
    expect(() =>
      guard.canActivate(
        contextFor('POST', { csrf_token: 'abc123' }, { 'x-csrf-token': 'different' }),
      ),
    ).toThrow(CsrfError);
  });

  it('rejects PATCH/PUT/DELETE the same way as POST', () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect(() => guard.canActivate(contextFor(method, {}, {}))).toThrow(CsrfError);
    }
  });
});
