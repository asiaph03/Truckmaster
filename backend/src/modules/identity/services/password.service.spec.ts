import { PasswordService } from './password.service';
import { ValidationError } from '../../../common/errors/app-error';

describe('PasswordService', () => {
  const service = new PasswordService();

  describe('assertValid (Workflow 1 §1.3 password policy — technical default)', () => {
    it('rejects passwords shorter than the minimum length', () => {
      expect(() => service.assertValid('Ab1')).toThrow(ValidationError);
    });

    it('rejects passwords with no number', () => {
      expect(() => service.assertValid('NoNumbersHere')).toThrow(ValidationError);
    });

    it('rejects passwords with no letter', () => {
      expect(() => service.assertValid('123456789012')).toThrow(ValidationError);
    });

    it('accepts a password meeting the policy', () => {
      expect(() => service.assertValid('ValidPass123')).not.toThrow();
    });
  });

  describe('hash / verify round trip', () => {
    it('produces a hash that verifies against the original password', async () => {
      const hash = await service.hash('ValidPass123');
      expect(hash).not.toBe('ValidPass123');
      await expect(service.verify('ValidPass123', hash)).resolves.toBe(true);
    });

    it('rejects an incorrect password against a real hash', async () => {
      const hash = await service.hash('ValidPass123');
      await expect(service.verify('WrongPass123', hash)).resolves.toBe(false);
    });

    it('hash() enforces the password policy before hashing', async () => {
      await expect(service.hash('short')).rejects.toThrow(ValidationError);
    });
  });
});
