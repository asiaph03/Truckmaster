import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { apiRequest, setUnauthorizedHandler } from './client';
import { ApiError } from './errors';

describe('apiRequest', () => {
  it('returns the parsed JSON body on success', async () => {
    server.use(
      http.get('/api/v1/customers/abc', () => HttpResponse.json({ id: 'abc', legalName: 'Acme' })),
    );

    const result = await apiRequest<{ id: string; legalName: string }>('/customers/abc');
    expect(result).toEqual({ id: 'abc', legalName: 'Acme' });
  });

  it('sends query params and JSON body correctly', async () => {
    server.use(
      http.get('/api/v1/customers', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('status')).toBe('ACTIVE');
        return HttpResponse.json([]);
      }),
    );

    await apiRequest('/customers', { query: { status: 'ACTIVE', unset: undefined } });
  });

  it('throws an ApiError with the code/message/details from the error envelope', async () => {
    server.use(
      http.post('/api/v1/customers', () =>
        HttpResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'Duplicate found.',
              details: { reasonCode: 'POSSIBLE_DUPLICATE_CUSTOMER' },
            },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(apiRequest('/customers', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'Duplicate found.',
      details: { reasonCode: 'POSSIBLE_DUPLICATE_CUSTOMER' },
    });
  });

  it('invokes the registered unauthorized handler on a 401, and still throws', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    server.use(
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json(
          { error: { code: 'AUTHENTICATION_ERROR', message: 'Authentication required.' } },
          { status: 401 },
        ),
      ),
    );

    await expect(apiRequest('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(() => {});
  });
});
