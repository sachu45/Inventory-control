import { Module } from '@nestjs/common';
import { TenantConfigModule } from '../../common/config/config.module';
import { PlatformModule } from '../platform/platform.module';
import { ConfigAdminController } from './config-admin.controller';
import { ConfigAdminService } from './config-admin.service';

@Module({
  imports: [TenantConfigModule, PlatformModule],
  controllers: [ConfigAdminController],
  providers: [ConfigAdminService],
})
export class ConfigAdminModule {}
