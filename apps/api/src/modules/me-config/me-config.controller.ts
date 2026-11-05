import { Body, Controller, Get, Headers, HttpStatus, Param, Put, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { MeConfigService } from './me-config.service';
import { CustomFieldsPassthrough } from '../../common/config/custom-field-values';

@ApiTags('me')
@CustomFieldsPassthrough()
@Controller('me')
export class MeConfigController {
  constructor(private readonly meConfig: MeConfigService) {}

  @Get('config')
  @ApiOperation({ summary: "The current user's modules, sidebar and preferences; supports If-None-Match" })
  async config(
    @CurrentUser() user: RequestUser,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { body, etag } = await this.meConfig.build(user);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (ifNoneMatch?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return body;
  }

  @Put('preferences/:scope')
  @ApiOperation({ summary: "Replace the current user's preferences for one scope (module key or 'sidebar')" })
  setPreferences(
    @CurrentUser() user: RequestUser,
    @Param('scope') scope: string,
    // Validated by the strict zod schema in UserPreferenceService, not class-validator.
    @Body() prefs: Record<string, unknown>,
  ) {
    return this.meConfig.setPreferences(user, scope, prefs);
  }
}
