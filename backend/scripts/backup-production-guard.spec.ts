import { assertProductionDatabaseTarget, PRODUCTION_DATABASE_NAME } from './backup-production-guard';

/**
 * Task #10C.6C — the production backup orchestration's fail-closed
 * target guard. Unlike every other database-name guard in this repo,
 * this is an allow-list of exactly one value, not a deny-list — these
 * tests exercise the one accepted value plus a representative set of
 * rejected ones, including the exact "obviously wrong" names called out
 * in the task (tms_local_test, postgres, template0, template1, empty)
 * plus an arbitrary unexpected name.
 */
describe('assertProductionDatabaseTarget', () => {
  it('accepts exactly "tms_dev"', () => {
    expect(() => assertProductionDatabaseTarget('tms_dev')).not.toThrow();
    expect(PRODUCTION_DATABASE_NAME).toBe('tms_dev');
  });

  it('rejects tms_local_test', () => {
    expect(() => assertProductionDatabaseTarget('tms_local_test')).toThrow(
      /Refusing to run production backup: resolved database is "tms_local_test", expected exactly "tms_dev"/,
    );
  });

  it('rejects postgres', () => {
    expect(() => assertProductionDatabaseTarget('postgres')).toThrow(/expected exactly "tms_dev"/);
  });

  it('rejects template0', () => {
    expect(() => assertProductionDatabaseTarget('template0')).toThrow(/expected exactly "tms_dev"/);
  });

  it('rejects template1', () => {
    expect(() => assertProductionDatabaseTarget('template1')).toThrow(/expected exactly "tms_dev"/);
  });

  it('rejects an empty string', () => {
    expect(() => assertProductionDatabaseTarget('')).toThrow(
      /Refusing to run production backup: resolved database is "", expected exactly "tms_dev"/,
    );
  });

  it('rejects an arbitrary unexpected database name', () => {
    expect(() => assertProductionDatabaseTarget('some_other_database')).toThrow(/expected exactly "tms_dev"/);
  });

  it('rejects a name that merely contains "tms_dev" as a substring', () => {
    expect(() => assertProductionDatabaseTarget('tms_dev_staging')).toThrow(/expected exactly "tms_dev"/);
    expect(() => assertProductionDatabaseTarget('not_tms_dev')).toThrow(/expected exactly "tms_dev"/);
  });
});
