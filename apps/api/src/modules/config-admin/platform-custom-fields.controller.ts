import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { PLATFORM_CONFIG_RATE_LIMIT } from './config-admin.controller';
import { PlatformCustomFieldsService } from './platform-custom-fields.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * Draft custom field definitions per tenant; they go live when the config is published.
 * Bodies are validated by the service's schemas, not class-validator: the app's implicit
 * conversion would turn the string "false" into true before a DTO could check it.
 */
@ApiTags('platform')
@Controller('platform/tenants')
@UseGuards(PlatformAdminGuard)
@Throttle({ global: { ttl: 60_000, limit: PLATFORM_CONFIG_RATE_LIMIT } })
export class PlatformCustomFieldsController {
  constructor(private readonly fields: PlatformCustomFieldsService) {}

  @Get(':companyId/draft/custom-fields')
  @ApiOperation({ summary: 'Draft custom fields, archived included, optionally for one module' })
  list(@Param('companyId', uuid) companyId: string, @Query('module') moduleKey?: string) {
    return this.fields.list(companyId, moduleKey);
  }

  @Post(':companyId/draft/custom-fields')
  @ApiOperation({ summary: 'Create a draft custom field' })
  create(@Param('companyId', uuid) companyId: string, @Body() body: unknown, @CurrentUser() actor: RequestUser) {
    return this.fields.create(companyId, body, actor);
  }

  @Patch(':companyId/draft/custom-fields/:id')
  @ApiOperation({ summary: 'Update a draft custom field, within the lifecycle rules' })
  update(
    @Param('companyId', uuid) companyId: string,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.fields.update(companyId, id, body, actor);
  }

  @Post(':companyId/draft/custom-fields/:id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a custom field: hidden and not validated, values kept' })
  archive(@Param('companyId', uuid) companyId: string, @Param('id', uuid) id: string, @CurrentUser() actor: RequestUser) {
    return this.fields.setArchived(companyId, id, true, actor);
  }

  @Post(':companyId/draft/custom-fields/:id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore an archived custom field' })
  restore(@Param('companyId', uuid) companyId: string, @Param('id', uuid) id: string, @CurrentUser() actor: RequestUser) {
    return this.fields.setArchived(companyId, id, false, actor);
  }
}
