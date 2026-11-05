import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { PLATFORM_CONFIG_RATE_LIMIT } from './config-admin.controller';
import { PlatformWorkflowsService } from './platform-workflows.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/** A tenant's workflow graphs. Bodies are validated by the service and the workflow compiler. */
@ApiTags('platform')
@Controller('platform/tenants')
@UseGuards(PlatformAdminGuard)
@Throttle({ global: { ttl: 60_000, limit: PLATFORM_CONFIG_RATE_LIMIT } })
export class PlatformWorkflowsController {
  constructor(private readonly workflows: PlatformWorkflowsService) {}

  @Get(':companyId/workflows')
  @ApiOperation({ summary: "A tenant's workflows, and the system defaults it can clone or override" })
  list(@Param('companyId', uuid) companyId: string) {
    return this.workflows.list(companyId);
  }

  @Post(':companyId/workflows')
  @ApiOperation({ summary: 'Compile and publish a new workflow; an invalid graph gets 422 with the compiler errors' })
  create(@Param('companyId', uuid) companyId: string, @Body() body: unknown, @CurrentUser() actor: RequestUser) {
    return this.workflows.create(companyId, body, actor);
  }

  @Put(':companyId/workflows/:id')
  @ApiOperation({ summary: 'Compile and publish a new version; running threads stay on theirs' })
  update(
    @Param('companyId', uuid) companyId: string,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.workflows.update(companyId, id, body, actor);
  }

  @Post(':companyId/workflows/:id/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish the latest version again' })
  enable(@Param('companyId', uuid) companyId: string, @Param('id', uuid) id: string, @CurrentUser() actor: RequestUser) {
    return this.workflows.setEnabled(companyId, id, true, actor);
  }

  @Post(':companyId/workflows/:id/disable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop new runs; running threads finish on their version, with no fallback to the system default' })
  disable(@Param('companyId', uuid) companyId: string, @Param('id', uuid) id: string, @CurrentUser() actor: RequestUser) {
    return this.workflows.setEnabled(companyId, id, false, actor);
  }

  @Post(':companyId/workflows/:id/clone')
  @ApiOperation({ summary: 'Copy a workflow or system default into this or another company' })
  clone(
    @Param('companyId', uuid) companyId: string,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.workflows.clone(companyId, id, body, actor);
  }
}
