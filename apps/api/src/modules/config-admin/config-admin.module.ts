import { Module } from '@nestjs/common';
import { TenantConfigModule } from '../../common/config/config.module';
import { WorkflowEngineModule } from '../../common/workflow-engine/workflow-engine.module';
import { PlatformModule } from '../platform/platform.module';
import { ConfigAdminController } from './config-admin.controller';
import { ConfigAdminService } from './config-admin.service';
import { PlatformFeatureFlagsController } from './platform-feature-flags.controller';
import { PlatformFeatureFlagsService } from './platform-feature-flags.service';

@Module({
  imports: [TenantConfigModule, PlatformModule, WorkflowEngineModule],
  controllers: [ConfigAdminController, PlatformFeatureFlagsController],
  providers: [ConfigAdminService, PlatformFeatureFlagsService],
})
export class ConfigAdminModule {}
