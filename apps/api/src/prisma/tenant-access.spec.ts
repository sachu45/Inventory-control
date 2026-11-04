import { MissingTenantContextReporter, callSite, tenantAccess, tenantContextMode } from './tenant-access';

describe('tenantContextMode', () => {
  it('is log unless TENANT_CONTEXT_MODE is strict', () => {
    expect(tenantContextMode(undefined)).toBe('log');
    expect(tenantContextMode('')).toBe('log');
    expect(tenantContextMode('nonsense')).toBe('log');
    expect(tenantContextMode(' Strict ')).toBe('strict');
  });
});

describe('tenantAccess', () => {
  it('uses the context when there is one, in either mode', () => {
    for (const mode of ['log', 'strict'] as const) {
      expect(tenantAccess({ companyId: 'c1', systemAccess: false }, mode)).toEqual({
        companyId: 'c1',
        systemAccess: false,
        missingContext: false,
      });
      expect(tenantAccess({ companyId: null, systemAccess: true }, mode)).toEqual({
        companyId: '',
        systemAccess: true,
        missingContext: false,
      });
    }
  });

  it('without a context: system access in log mode (unchanged), none in strict mode', () => {
    expect(tenantAccess(undefined, 'log')).toEqual({ companyId: '', systemAccess: true, missingContext: true });
    expect(tenantAccess(undefined, 'strict')).toEqual({ companyId: '', systemAccess: false, missingContext: true });
  });
});

describe('MissingTenantContextReporter', () => {
  function setup(mode: 'log' | 'strict' = 'log') {
    const logger = { warn: jest.fn() };
    const counter = { inc: jest.fn() };
    return { logger, counter, reporter: new MissingTenantContextReporter(mode, logger, counter) };
  }

  it('counts every query but warns once per call site', () => {
    const { reporter, logger, counter } = setup();
    for (let i = 0; i < 3; i++) reporter.report('Company', 'findMany');
    expect(counter.inc).toHaveBeenCalledTimes(3);
    expect(counter.inc).toHaveBeenCalledWith({ model: 'Company', operation: 'findMany', mode: 'log' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('Company.findMany outside a TenantContext ran with RLS bypassed');
  });

  it('says what strict mode did', () => {
    const { reporter, logger } = setup('strict');
    reporter.report('Shop', 'count');
    expect(logger.warn.mock.calls[0][0]).toContain('ran without tenant or system access');
  });

  it('stops warning after five call sites for one operation, but keeps counting', () => {
    const { reporter, logger, counter } = setup();
    const sites = [() => reporter.report('A', 'b'), () => reporter.report('A', 'b'), () => reporter.report('A', 'b'),
      () => reporter.report('A', 'b'), () => reporter.report('A', 'b'), () => reporter.report('A', 'b'), () => reporter.report('A', 'b')];
    sites.forEach((call) => call());
    expect(logger.warn).toHaveBeenCalledTimes(5);
    expect(counter.inc).toHaveBeenCalledTimes(7);
  });
});

describe('callSite', () => {
  it('returns the first application frame', () => {
    const stack = [
      'Error',
      '    at MissingTenantContextReporter.report (/app/apps/api/src/prisma/tenant-access.ts:40:18)',
      '    at $allOperations (/app/apps/api/src/prisma/prisma.service.ts:80:22)',
      '    at runInTransaction (/app/node_modules/@prisma/client/runtime/library.js:1:1)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at BackupScheduler.tick (/app/apps/api/dist/modules/backup/backup.scheduler.js:42:9)',
    ].join('\n');
    expect(callSite(stack)).toBe('BackupScheduler.tick (/app/apps/api/dist/modules/backup/backup.scheduler.js:42:9)');
  });

  it('falls back to unknown', () => {
    expect(callSite(undefined)).toBe('unknown');
    expect(callSite('Error\n    at x (/app/node_modules/y.js:1:1)')).toBe('unknown');
  });
});
