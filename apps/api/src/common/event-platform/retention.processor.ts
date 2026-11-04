import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EVENT_PLATFORM_MAINTENANCE_QUEUE } from './event-platform.constants';
import { RetentionService } from './retention.service';
import { TenantContext } from '../tenant/tenant-context';

/** Runs the daily retention cleanup on the maintenance queue. */
@Processor(EVENT_PLATFORM_MAINTENANCE_QUEUE)
export class RetentionProcessor extends WorkerHost {
  constructor(private readonly retention: RetentionService) {
    super();
  }

  /**
   * Background job with no request: system access is explicit rather than the
   * implicit no-context fallback (#239).
   */
  process(_job: Job) {
    return TenantContext.runWithSystemAccess(() => this.handle(_job));
  }

  private async handle(_job: Job): Promise<void> {
    await this.retention.cleanup();
  }
}
