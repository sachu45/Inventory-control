import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { ConfigAdminService } from './config-admin.service';
import {
  ConfigAuditQueryDto,
  EffectiveConfigQueryDto,
  ListTenantsQueryDto,
  PublishConfigDto,
  ResetDraftModuleQueryDto,
  SetDraftModuleDto,
} from './dto/config-admin.dto';
import { CustomFieldsPassthrough } from '../../common/config/custom-field-values';

/** Requests per minute per client on these routes; the app-wide default is 120. */
export const PLATFORM_CONFIG_RATE_LIMIT = 60;

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('platform')
@CustomFieldsPassthrough()
@Controller('platform/tenants')
@UseGuards(PlatformAdminGuard)
@Throttle({ global: { ttl: 60_000, limit: PLATFORM_CONFIG_RATE_LIMIT } })
export class ConfigAdminController {
  constructor(private readonly admin: ConfigAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List tenants with their active config version' })
  listTenants(@Query() query: ListTenantsQueryDto) {
    return this.admin.listTenants(query);
  }

  @Get(':companyId')
  @ApiOperation({ summary: 'Tenant summary: shops, active config version, draft count' })
  getTenant(@Param('companyId', uuid) companyId: string) {
    return this.admin.getTenant(companyId);
  }

  @Get(':companyId/draft/modules')
  @ApiOperation({ summary: 'Registry modules with the company and shop draft rows' })
  listDrafts(@Param('companyId', uuid) companyId: string) {
    return this.admin.listDrafts(companyId);
  }

  @Put(':companyId/draft/modules/:key')
  @ApiOperation({ summary: 'Create or update the company-wide draft for a module' })
  setDraft(
    @Param('companyId', uuid) companyId: string,
    @Param('key') key: string,
    @Body() body: SetDraftModuleDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.admin.setDraft(companyId, null, key, body, actor);
  }

  @Delete(':companyId/draft/modules/:key')
  @ApiOperation({ summary: 'Reset a module draft to the registry default' })
  resetDraft(
    @Param('companyId', uuid) companyId: string,
    @Param('key') key: string,
    @Query() query: ResetDraftModuleQueryDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.admin.resetDraft(companyId, null, key, query.revision, actor);
  }

  @Put(':companyId/draft/shops/:shopId/modules/:key')
  @ApiOperation({ summary: 'Create or update a shop override draft for a module' })
  setShopDraft(
    @Param('companyId', uuid) companyId: string,
    @Param('shopId', uuid) shopId: string,
    @Param('key') key: string,
    @Body() body: SetDraftModuleDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.admin.setDraft(companyId, shopId, key, body, actor);
  }

  @Delete(':companyId/draft/shops/:shopId/modules/:key')
  @ApiOperation({ summary: 'Remove a shop override draft' })
  resetShopDraft(
    @Param('companyId', uuid) companyId: string,
    @Param('shopId', uuid) shopId: string,
    @Param('key') key: string,
    @Query() query: ResetDraftModuleQueryDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.admin.resetDraft(companyId, shopId, key, query.revision, actor);
  }

  @Post(':companyId/draft/preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Compile the drafts without publishing: snapshot, diff and every validation issue' })
  preview(@Param('companyId', uuid) companyId: string) {
    return this.admin.preview(companyId);
  }

  @Post(':companyId/publish')
  @ApiOperation({ summary: 'Publish the drafts as a new config version' })
  publish(@Param('companyId', uuid) companyId: string, @Body() body: PublishConfigDto, @CurrentUser() actor: RequestUser) {
    return this.admin.publish(companyId, body.expectedBaseVersion, body.note, actor);
  }

  @Get(':companyId/versions')
  @ApiOperation({ summary: 'Published config versions, newest first' })
  listVersions(@Param('companyId', uuid) companyId: string) {
    return this.admin.listVersions(companyId);
  }

  @Get(':companyId/versions/:version')
  @ApiOperation({ summary: 'One published version including its snapshot' })
  getVersion(@Param('companyId', uuid) companyId: string, @Param('version', ParseIntPipe) version: number) {
    return this.admin.getVersion(companyId, version);
  }

  @Get(':companyId/versions/:from/diff/:to')
  @ApiOperation({ summary: 'Structural diff between two versions (0 = registry defaults)' })
  diff(
    @Param('companyId', uuid) companyId: string,
    @Param('from', ParseIntPipe) from: number,
    @Param('to', ParseIntPipe) to: number,
  ) {
    return this.admin.diff(companyId, from, to);
  }

  @Post(':companyId/versions/:version/rollback')
  @ApiOperation({ summary: 'Publish a copy of an earlier version and reset drafts to it' })
  rollback(
    @Param('companyId', uuid) companyId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() body: PublishConfigDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.admin.rollback(companyId, version, body.expectedBaseVersion, body.note, actor);
  }

  @Get(':companyId/effective')
  @ApiOperation({ summary: 'Effective config with provenance, optionally for a shop and user' })
  effective(@Param('companyId', uuid) companyId: string, @Query() query: EffectiveConfigQueryDto) {
    return this.admin.effective(companyId, query.shopId, query.userId);
  }

  @Get(':companyId/audit')
  @ApiOperation({ summary: 'Config audit trail for the tenant' })
  audit(@Param('companyId', uuid) companyId: string, @Query() query: ConfigAuditQueryDto) {
    return this.admin.configAudit(companyId, query.take, query.cursor);
  }
}
