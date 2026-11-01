import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { RequestContextStore } from '@/common/context/request-context';
import { Public } from '@/common/decorators/public.decorator';
import { SkipEnvelope } from '@/common/decorators/skip-envelope.decorator';

@Controller('health')
export class HealthController {
  constructor(private healthService: HealthService) {}

  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  health() {
    return {
      ...this.healthService.getHealth(),
      requestId: RequestContextStore.getRequestId(),
    };
  }

  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return {
      ...this.healthService.getLive(),
      requestId: RequestContextStore.getRequestId(),
    };
  }

  @Public()
  @SkipEnvelope()
  @Get('ready')
  async ready(@Res() res: Response) {
    const result = await this.healthService.getReady();
    const status = result.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(status).json({
      ...result,
      requestId: RequestContextStore.getRequestId(),
      timestamp: new Date().toISOString(),
    });
  }
}
