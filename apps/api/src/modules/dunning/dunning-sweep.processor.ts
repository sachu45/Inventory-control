import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DUNNING_QUEUE } from './dunning.constants';
import { DunningSweepService } from './dunning-sweep.service';
import { TenantContext } from '../../common/tenant/tenant-context';

@Processor(DUNNING_QUEUE)
export class DunningSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(DunningSweepProcessor.name);

  constructor(private readonly sweep: DunningSweepService) {
    super();
  }

  /**
   * Background job with no request: system access is explicit rather than the
   * implicit no-context fallback (#239).
   */
  process(_job: Job) {
    return TenantContext.runWithSystemAccess(() => this.handle(_job));
  }

  private async handle(_job: Job) {
    void _job;
    return this.sweep.sweep();
  }
}
