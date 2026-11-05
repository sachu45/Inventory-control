import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DISPATCH_JOB, NOTIFICATION_DISPATCH_QUEUE } from './dispatch.constants';
import { DispatchJobData } from './dispatch-job';
import { DispatchBatchService } from './dispatch-batch.service';
import { CustomerDispatchService } from './customer-dispatch.service';
import { runJobAsCompany } from '../../tenant/job-tenant';

/**
 * Worker for the dispatch queue (Plan §11). Performs deferred sends when their
 * quiet-hours window opens, and flushes a customer's accumulated low-priority
 * sends as a single digest.
 */
@Processor(NOTIFICATION_DISPATCH_QUEUE)
export class DispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(DispatchProcessor.name);

  constructor(
    private readonly dispatch: CustomerDispatchService,
    private readonly batch: DispatchBatchService,
  ) {
    super();
  }

  /** Runs as the company the job is for (#239); both job kinds carry it. */
  process(job: Job) {
    const companyId = (job.data as { companyId?: string } | undefined)?.companyId;
    return runJobAsCompany(`dispatch ${job.name}`, () => companyId, () => this.handle(job), this.logger);
  }

  private async handle(job: Job): Promise<void> {
    if (job.name === DISPATCH_JOB.DEFERRED_SEND) {
      await this.dispatch.sendDeferred(job.data as DispatchJobData);
      return;
    }
    if (job.name === DISPATCH_JOB.FLUSH_BATCH) {
      const { companyId, customerId } = job.data as { companyId: string; customerId: string };
      const items = await this.batch.collectPending(companyId, customerId);
      if (items.length === 0) return;
      try {
        await this.dispatch.sendDigest(companyId, customerId, items);
      } catch (err) {
        // Put the items back so the job's retry (or the next flush) sends them.
        await this.batch.release(items);
        throw err;
      }
      await this.batch.markSent(items);
      return;
    }
    this.logger.warn(`Unknown dispatch job "${job.name}" ignored.`);
  }
}
