import { BadRequestException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { PrismaService } from '@/prisma/prisma.service';
import { actionError, conditionError, MAX_CONDITION_BRANCHES, MAX_IN_VALUES, PolicyService } from './policy.service';

const COMPANY = '11111111-1111-4111-8111-111111111111';

const pred = { fact: 'daysOverdue', op: 'gt' as const, value: 30 };

describe('policy condition validation', () => {
  it('accepts predicates and nested all/any/not', () => {
    expect(conditionError(pred)).toBeNull();
    expect(conditionError({ all: [pred, { any: [pred, { not: pred }] }] })).toBeNull();
    expect(conditionError({ fact: 'channel', op: 'in', value: ['EMAIL', 'SMS'] })).toBeNull();
  });

  it('rejects malformed conditions', () => {
    expect(conditionError(null)).toMatch(/object/);
    expect(conditionError({ all: pred })).toMatch(/array/);
    expect(conditionError({ fact: '', op: 'gt' })).toMatch(/fact/);
    expect(conditionError({ fact: 'x', op: 'like' })).toMatch(/comparator/);
    expect(conditionError({ fact: 'x', op: 'in', value: 'a' })).toMatch(/array/);
  });

  it(`caps all/any at ${MAX_CONDITION_BRANCHES} conditions`, () => {
    expect(conditionError({ all: Array(MAX_CONDITION_BRANCHES).fill(pred) })).toBeNull();
    expect(conditionError({ all: Array(MAX_CONDITION_BRANCHES + 1).fill(pred) })).toMatch(/at most 50/);
    expect(conditionError({ any: [{ any: Array(MAX_CONDITION_BRANCHES + 1).fill(pred) }] })).toMatch(/at most 50/);
  });

  it(`caps "in" at ${MAX_IN_VALUES} values`, () => {
    expect(conditionError({ fact: 'x', op: 'in', value: Array(MAX_IN_VALUES).fill('a') })).toBeNull();
    expect(conditionError({ fact: 'x', op: 'in', value: Array(MAX_IN_VALUES + 1).fill('a') })).toMatch(/at most 500/);
  });

  it('caps nesting depth', () => {
    let deep: unknown = pred;
    for (let i = 0; i < 12; i++) deep = { not: deep };
    expect(conditionError(deep)).toMatch(/nested too deeply/);
  });
});

describe('policy action validation', () => {
  it('accepts a valid action and rejects bad fields', () => {
    expect(actionError({ channel: 'EMAIL', priority: 'HIGH', maxPerDay: 2, suppress: false })).toBeNull();
    expect(actionError([])).toMatch(/object/);
    expect(actionError({ maxPerDay: -1 })).toMatch(/non-negative/);
    expect(actionError({ priority: 'URGENT' })).toMatch(/priority/);
    expect(actionError({ suppress: 'yes' })).toMatch(/boolean/);
  });
});

describe('PolicyService rules and cache', () => {
  function setup(redisDown = false) {
    const store = new Map<string, string>();
    const fail = () => {
      if (redisDown) throw new Error('redis down');
    };
    const redis = {
      get: jest.fn(async (k: string) => (fail(), store.get(k) ?? null)),
      set: jest.fn(async (k: string, v: string) => (fail(), store.set(k, v), 'OK')),
      incr: jest.fn(async (k: string) => {
        fail();
        const next = Number(store.get(k) ?? '0') + 1;
        store.set(k, String(next));
        return next;
      }),
    };
    const rows = [
      { id: 'p-high', name: 'escalate', priority: 10, condition: pred, action: { priority: 'HIGH' } },
      { id: 'p-bad', name: 'broken', priority: 20, condition: { fact: 'x', op: 'like' }, action: {} },
    ];
    const prisma = {
      notificationPolicy: {
        findMany: jest.fn(async () => rows),
        create: jest.fn(async ({ data }: { data: unknown }) => data),
      },
    };
    const service = new PolicyService(prisma as unknown as PrismaService, redis as unknown as Redis);
    return { service, prisma, redis };
  }

  it('applies matching rules and skips a malformed stored rule', async () => {
    const { service } = setup();
    expect(await service.decide(COMPANY, 'dunning', { daysOverdue: 45 })).toEqual({ action: { priority: 'HIGH' }, matched: ['p-high'] });
    expect((await service.decide(COMPANY, 'dunning', { daysOverdue: 5 })).matched).toEqual([]);
  });

  it('caches rules per company and scope, and a write invalidates them', async () => {
    const { service, prisma } = setup();
    await service.decide(COMPANY, 'dunning', {});
    await service.decide(COMPANY, 'dunning', {});
    expect(prisma.notificationPolicy.findMany).toHaveBeenCalledTimes(1);

    await service.create(COMPANY, { name: 'new', condition: pred, action: { suppress: true } });
    await service.decide(COMPANY, 'dunning', {});
    expect(prisma.notificationPolicy.findMany).toHaveBeenCalledTimes(2);
  });

  it('reads Postgres when Redis is down', async () => {
    const { service, prisma } = setup(true);
    expect((await service.decide(COMPANY, 'dunning', { daysOverdue: 45 })).matched).toEqual(['p-high']);
    await expect(service.create(COMPANY, { name: 'new', condition: pred, action: {} })).resolves.toBeDefined();
    expect(prisma.notificationPolicy.findMany).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized condition on create', async () => {
    const { service, prisma } = setup();
    await expect(
      service.create(COMPANY, { name: 'big', condition: { any: Array(MAX_CONDITION_BRANCHES + 1).fill(pred) }, action: {} }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.notificationPolicy.create).not.toHaveBeenCalled();
  });
});
