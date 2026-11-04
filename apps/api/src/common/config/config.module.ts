import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { ConfigDraftService } from './config-draft.service';
import { ConfigPublishService } from './config-publish.service';
import { ConfigResolverService } from './config-resolver.service';
import { ModuleRegistryService } from './module-registry.service';
import { UserPreferenceService } from './user-preference.service';

const providers = [
  ConfigResolverService,
  ConfigDraftService,
  ConfigPublishService,
  UserPreferenceService,
  ModuleRegistryService,
];

/** Tenant business config (spec §5). Named to avoid clashing with @nestjs/config's ConfigModule. */
@Module({
  imports: [CacheModule],
  providers,
  exports: providers,
})
export class TenantConfigModule {}
