import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { ValidationError } from '../../../common/errors/app-error';

const BCRYPT_COST_FACTOR = 12;

// Minimum password complexity. Workflow 1 §1.3 explicitly defers this to
// "a technical-architecture detail" — this is that detail, not a business
// rule. Documented here (and in the Phase 1 report) as a technical default
// rather than silently invented and left undocumented.
const MIN_LENGTH = 10;
const REQUIRES_LETTER_AND_NUMBER = /^(?=.*[A-Za-z])(?=.*\d).+$/;

@Injectable()
export class PasswordService {
  assertValid(password: string): void {
    if (password.length < MIN_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_LENGTH} characters.`);
    }
    if (!REQUIRES_LETTER_AND_NUMBER.test(password)) {
      throw new ValidationError('Password must contain at least one letter and one number.');
    }
  }

  async hash(password: string): Promise<string> {
    this.assertValid(password);
    return bcrypt.hash(password, BCRYPT_COST_FACTOR);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }
}
