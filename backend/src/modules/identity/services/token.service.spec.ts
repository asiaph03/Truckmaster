import { TokenService } from './token.service';

describe('TokenService (Workflow 1 §1.2-§1.4 verification/invitation tokens)', () => {
  const service = new TokenService();

  it('generates a raw token and its hash together', () => {
    const { raw, hash } = service.generate();
    expect(raw).toHaveLength(64); // 32 bytes hex-encoded
    expect(hash).toHaveLength(64); // sha256 hex digest
    expect(hash).not.toBe(raw);
  });

  it('hash() is deterministic — the same raw token always hashes the same way (needed to look it up by hash later)', () => {
    const { raw, hash } = service.generate();
    expect(service.hash(raw)).toBe(hash);
  });

  it('never generates the same raw token twice in practice', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => service.generate().raw));
    expect(tokens.size).toBe(50);
  });

  it('the stored hash cannot be reversed back to the raw token by re-hashing a guess', () => {
    const { hash } = service.generate();
    const guessHash = service.hash('guessed-token');
    expect(guessHash).not.toBe(hash);
  });
});
