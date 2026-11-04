import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { REDIS_CLIENT } from '../cache/redis.provider';
import { MetricsService } from '../observability/metrics.service';
import { AuditService } from '../../modules/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigDraftService } from './config-draft.service';
import { ConfigPublishService } from './config-publish.service';
import { ConfigResolverService } from './config-resolver.service';
import { TenantConfigModule } from './config.module';
import { ModuleAccessService } from './module-access.service';
import { ModuleRegistryService } from './module-registry.service';
import { UserPreferenceService } from './user-preference.service';

/** Stands in for the app's global Prisma, audit and metrics modules. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AuditService, useValue: { log: jest.fn() } },
    MetricsService,
  ],
  exports: [PrismaService, AuditService, MetricsService],
})
class FakeInfraModule {}

describe('TenantConfigModule', () => {
  it('resolves every exported provider without circular dependencies, sharing one resolver', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FakeInfraModule, TenantConfigModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ get: jest.fn(), set: jest.fn(), del: jest.fn(), quit: jest.fn() })
      .compile();

    for (const provider of [
      ConfigResolverService,
      ConfigDraftService,
      ConfigPublishService,
      UserPreferenceService,
      ModuleRegistryService,
      ModuleAccessService,
    ]) {
      expect(moduleRef.get(provider)).toBeInstanceOf(provider);
    }
    const resolver = moduleRef.get(ConfigResolverService);
    expect((moduleRef.get(ConfigPublishService) as unknown as { resolver: unknown }).resolver).toBe(resolver);
    expect((moduleRef.get(UserPreferenceService) as unknown as { resolver: unknown }).resolver).toBe(resolver);
    expect((moduleRef.get(ModuleAccessService) as unknown as { resolver: unknown }).resolver).toBe(resolver);
    await moduleRef.close();
  });
});
