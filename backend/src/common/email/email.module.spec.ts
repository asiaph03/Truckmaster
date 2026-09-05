import { chooseEmailSender } from './email.module';
import { PostmarkEmailSender } from './postmark-email-sender';
import { NoopEmailSender } from './noop-email-sender';

/**
 * Task #6 — proves E2E/test mode cannot bind to the real Postmark
 * sender. Pure-function test, no DI container, no network.
 */
describe('chooseEmailSender', () => {
  const postmark = { send: jest.fn() } as unknown as PostmarkEmailSender;
  const noop = { send: jest.fn() } as unknown as NoopEmailSender;

  it('binds the no-op sender when nodeEnv is "test"', () => {
    expect(chooseEmailSender('test', postmark, noop)).toBe(noop);
  });

  it('never binds the real Postmark sender when nodeEnv is "test"', () => {
    expect(chooseEmailSender('test', postmark, noop)).not.toBe(postmark);
  });

  it('binds the real Postmark sender in production', () => {
    expect(chooseEmailSender('production', postmark, noop)).toBe(postmark);
  });

  it('binds the real Postmark sender in development (existing behavior unchanged)', () => {
    expect(chooseEmailSender('development', postmark, noop)).toBe(postmark);
  });
});
