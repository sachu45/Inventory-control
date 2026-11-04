import { Module } from '@nestjs/common';
import { TenantConfigModule } from '../../common/config/config.module';
import { MeConfigController } from './me-config.controller';
import { MeConfigService } from './me-config.service';

@Module({
  imports: [TenantConfigModule],
  controllers: [MeConfigController],
  providers: [MeConfigService],
})
export class MeConfigModule {}
