import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { PrismaService } from '@/prisma/prisma.service';
import { FEATURE_FLAG_SCOPE } from '../ops/feature-flags.service';
import { PolicyService } from './policy.service';

const COMPANY = '11111111-1111-4111-8111-111111111111';

/** Feature-flag rows live in notification_policies; the policy API must not reach them (#243). */
describe('PolicyService and the reserved feature-flag scope', () => {
  const prisma = {
    notificationPolicy: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
  };
  const redis = { incr: jest.fn(async () => 1), get: jest.fn(async () => null) };
  const service = new PolicyService(prisma as unknown as PrismaService, redis as unknown as Redis);
  const valid = { name: 'ai-advisor', condition: {}, action: { enabled: true } } as never;

  beforeEach(() => jest.clearAllMocks());

  it('refuses to create a policy in the feature-flag scope', async () => {
    await expect(service.create(COMPANY, { ...(valid as object), scope: FEATURE_FLAG_SCOPE } as never)).rejects.toThrow(BadRequestException);
    expect(prisma.notificationPolicy.create).not.toHaveBeenCalled();
  });

  it('refuses to move a policy into the feature-flag scope', async () => {
    prisma.notificationPolicy.findFirst.mockResolvedValueOnce({ id: 'p1' } as never);
    await expect(service.update(COMPANY, 'p1', { scope: FEATURE_FLAG_SCOPE })).rejects.toThrow(BadRequestException);
    expect(prisma.notificationPolicy.update).not.toHaveBeenCalled();
  });

  it('never lists, updates or deletes flag rows', async () => {
    await service.list(COMPANY);
    await service.list(COMPANY, FEATURE_FLAG_SCOPE);
    for (const [args] of prisma.notificationPolicy.findMany.mock.calls as unknown as [{ where: unknown }][]) {
      expect(JSON.stringify(args.where)).toContain(JSON.stringify({ scope: { not: FEATURE_FLAG_SCOPE } }));
    }

    await expect(service.update(COMPANY, 'flag-row', { enabled: false })).rejects.toThrow(NotFoundException);
    await expect(service.remove(COMPANY, 'flag-row')).rejects.toThrow(NotFoundException);
    for (const [args] of prisma.notificationPolicy.findFirst.mock.calls as unknown as [{ where: Record<string, unknown> }][]) {
      expect(args.where.scope).toEqual({ not: FEATURE_FLAG_SCOPE });
    }
  });
});
