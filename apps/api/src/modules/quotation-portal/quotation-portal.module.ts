import { Module } from '@nestjs/common';
import { TenantConfigModule } from '../../common/config/config.module';
import { QuotationPortalController } from './quotation-portal.controller';
import { QuotationPortalService } from './quotation-portal.service';

@Module({
  imports: [TenantConfigModule],
  controllers: [QuotationPortalController],
  providers: [QuotationPortalService],
})
export class QuotationPortalModule {}
