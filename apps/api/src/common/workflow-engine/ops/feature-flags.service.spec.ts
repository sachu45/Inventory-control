import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { PrismaService } from '@/prisma/prisma.service';
import { WorkflowEngineController } from '../workflow-engine.controller';
import { parseEnabled, ParseWorkflowFeaturePipe } from './feature-flag.pipe';
import { FEATURE_FLAG_SCOPE, FeatureFlagsService, isWorkflowFeature, WORKFLOW_FEATURES } from './feature-flags.service';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function setup(opts: { env?: Record<string, string>; overrides?: Record<string, boolean>; redisDown?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn(async (k: string) => {
      if (opts.redisDown) throw new Error('redis down');
      return store.get(k) ?? null;
    }),
    set: jest.fn(async (k: string, v: string) => {
      if (opts.redisDown) throw new Error('redis down');
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => {
      if (opts.redisDown) throw new Error('redis down');
      return store.delete(k) ? 1 : 0;
    }),
  };
  const overrides = new Map(Object.entries(opts.overrides ?? {}));
  const executeRaw = jest.fn(async () => 1);
  const prisma = {
    notificationPolicy: {
      findFirst: jest.fn(async ({ where }: { where: { name: string } }) =>
        overrides.has(where.name) ? { action: { enabled: overrides.get(where.name) } } : null,
      ),
      findMany: jest.fn(async () => [...overrides].map(([name, enabled]) => ({ name, companyId: COMPANY, action: { enabled } }))),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ $executeRaw: executeRaw })),
  };
  const config = { get: jest.fn((k: string) => opts.env?.[k]) };
  const service = new FeatureFlagsService(
    config as unknown as ConfigService,
    prisma as unknown as PrismaService,
    redis as unknown as Redis,
  );
  return { service, prisma, redis, store, overrides, executeRaw };
}

describe('FeatureFlagsService', () => {
  it('resolves a company override over the env default over the built-in default', async () => {
    // Built-in: simulation on, ai-advisor off.
    expect(await setup().service.isEnabled(COMPANY, 'simulation')).toBe(true);
    expect(await setup().service.isEnabled(COMPANY, 'ai-advisor')).toBe(false);
    // Env beats built-in.
    expect(await setup({ env: { WORKFLOW_FLAG_AI_ADVISOR: 'true' } }).service.isEnabled(COMPANY, 'ai-advisor')).toBe(true);
    expect(await setup({ env: { WORKFLOW_FLAG_SIMULATION: 'false' } }).service.isEnabled(COMPANY, 'simulation')).toBe(false);
    // Override beats env.
    const { service } = setup({ env: { WORKFLOW_FLAG_AI_ADVISOR: 'true' }, overrides: { 'ai-advisor': false } });
    expect(await service.isEnabled(COMPANY, 'ai-advisor')).toBe(false);
  });

  it('serves repeat reads from the cache', async () => {
    const { service, prisma } = setup({ overrides: { optimizer: true } });
    expect(await service.isEnabled(COMPANY, 'optimizer')).toBe(true);
    expect(await service.isEnabled(COMPANY, 'optimizer')).toBe(true);
    expect(prisma.notificationPolicy.findFirst).toHaveBeenCalledTimes(1);
  });

  it('falls back to Postgres when Redis is down', async () => {
    const { service, prisma } = setup({ overrides: { optimizer: true }, redisDown: true });
    expect(await service.isEnabled(COMPANY, 'optimizer')).toBe(true);
    expect(prisma.notificationPolicy.findFirst).toHaveBeenCalledTimes(1);
  });

  it('writes with a single upsert and invalidates the cached value', async () => {
    const t = setup();
    expect(await t.service.isEnabled(COMPANY, 'optimizer')).toBe(false);
    expect(t.store.size).toBe(1);

    const result = await t.service.setEnabled(COMPANY, 'optimizer', true);
    expect(result).toEqual({ feature: 'optimizer', enabled: true, previous: null });
    expect(t.executeRaw).toHaveBeenCalledTimes(1);
    const sql = (t.executeRaw.mock.calls[0] as unknown[])[0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain(`ON CONFLICT (company_id, name) WHERE scope = '${FEATURE_FLAG_SCOPE}'`);
    expect(sql.values).toEqual(expect.arrayContaining([COMPANY, 'optimizer', JSON.stringify({ enabled: true })]));
    expect(t.redis.del).toHaveBeenCalledWith(`wf:flag:${COMPANY}:optimizer`);
    expect(t.store.size).toBe(0);
  });

  it('reports the previous override, and survives a cache invalidation failure', async () => {
    const { service } = setup({ overrides: { optimizer: true }, redisDown: true });
    await expect(service.setEnabled(COMPANY, 'optimizer', false)).resolves.toEqual({
      feature: 'optimizer',
      enabled: false,
      previous: true,
    });
  });

  it('lists every flag with its source and whether the tenant may switch it', async () => {
    const { service } = setup({ env: { WORKFLOW_FLAG_OPTIMIZER: 'true' }, overrides: { 'ai-advisor': true } });
    const flags = await service.list(COMPANY);
    expect(flags.map((f) => f.feature)).toEqual([...WORKFLOW_FEATURES]);
    expect(flags.find((f) => f.feature === 'ai-advisor')).toEqual({ feature: 'ai-advisor', enabled: true, source: 'override', tenantWritable: false });
    expect(flags.find((f) => f.feature === 'optimizer')).toEqual({ feature: 'optimizer', enabled: true, source: 'env', tenantWritable: false });
    expect(flags.find((f) => f.feature === 'simulation')).toEqual({ feature: 'simulation', enabled: true, source: 'default', tenantWritable: true });
  });
});

describe('feature flag input', () => {
  it('accepts only known flags', () => {
    const pipe = new ParseWorkflowFeaturePipe();
    expect(pipe.transform('graph-execution')).toBe('graph-execution');
    expect(() => pipe.transform('anything')).toThrow(BadRequestException);
    expect(() => pipe.transform('__proto__')).toThrow(BadRequestException);
    expect(isWorkflowFeature(undefined)).toBe(false);
  });

  it('requires enabled to be a boolean', () => {
    expect(parseEnabled({ enabled: false })).toBe(false);
    expect(() => parseEnabled({ enabled: 'true' })).toThrow(BadRequestException);
    expect(() => parseEnabled({})).toThrow(BadRequestException);
  });
});

describe('tenant flag route', () => {
  const setEnabled = jest.fn(async () => ({}));
  const none = {} as never;
  const controller = new WorkflowEngineController(none, none, none, { setEnabled } as never, none, none, none, none, none);
  const user = { companyId: COMPANY } as never;

  beforeEach(() => setEnabled.mockClear());

  it('lets a tenant switch a tenant-writable flag', async () => {
    await controller.setFeature(user, 'channel-routing', { enabled: true });
    expect(setEnabled).toHaveBeenCalledWith(COMPANY, 'channel-routing', true);
  });

  it.each(['ai-advisor', 'graph-execution', 'predictive-ai', 'workflow-builder', 'optimizer'] as const)(
    'refuses %s with 403 FEATURE_FLAG_PLATFORM_ONLY',
    (feature) => {
      let error: unknown;
      try {
        controller.setFeature(user, feature, { enabled: true });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(JSON.stringify((error as ForbiddenException).getResponse())).toContain('FEATURE_FLAG_PLATFORM_ONLY');
      expect(setEnabled).not.toHaveBeenCalled();
    },
  );
});
