import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { parseEnabled, ParseWorkflowFeaturePipe } from '../../common/workflow-engine/ops/feature-flag.pipe';
import type { WorkflowFeature } from '../../common/workflow-engine/ops/feature-flags.service';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { PLATFORM_CONFIG_RATE_LIMIT } from './config-admin.controller';
import { PlatformFeatureFlagsService } from './platform-feature-flags.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/** Workflow feature flags per tenant. Any flag, including dark-launched ones, is set here. */
@ApiTags('platform')
@Controller('platform/tenants')
@UseGuards(PlatformAdminGuard)
@Throttle({ global: { ttl: 60_000, limit: PLATFORM_CONFIG_RATE_LIMIT } })
export class PlatformFeatureFlagsController {
  constructor(private readonly flags: PlatformFeatureFlagsService) {}

  @Get(':companyId/features')
  @ApiOperation({ summary: "A tenant's workflow feature flags and where each value comes from" })
  list(@Param('companyId', uuid) companyId: string) {
    return this.flags.list(companyId);
  }

  @Put(':companyId/features/:feature')
  @ApiOperation({ summary: 'Set a workflow feature flag override for a tenant' })
  set(
    @Param('companyId', uuid) companyId: string,
    @Param('feature', ParseWorkflowFeaturePipe) feature: WorkflowFeature,
    @Body() body: { enabled: boolean },
    @CurrentUser() actor: RequestUser,
  ) {
    return this.flags.set(companyId, feature, parseEnabled(body), actor);
  }
}
