import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentPdfService } from '../../common/pdf/document-pdf.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JobFailureService } from '../../common/queues/job-failure.service';
import { MetricsService } from '../../common/observability/metrics.service';
import { runJobAsCompany } from '../../common/tenant/job-tenant';

type ExportJob = { type: 'po-pdf'; purchaseOrderId: string };

@Processor('exports')
export class ExportProcessor extends WorkerHost {
  private readonly logger = new Logger(ExportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly failures: JobFailureService,
    private readonly metrics: MetricsService,
    private readonly documentPdf: DocumentPdfService,
  ) {
    super();
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ExportJob>) {
    const durationSec = (Date.now() - (job.processedOn ?? Date.now())) / 1000;
    this.metrics.bullJobDuration
      .labels('exports', String(job.name), 'completed')
      .observe(Math.max(0, durationSec));
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ExportJob>, err: Error) {
    const durationSec = (Date.now() - (job.processedOn ?? Date.now())) / 1000;
    this.metrics.bullJobDuration
      .labels('exports', String(job.name), 'failed')
      .observe(Math.max(0, durationSec));
    await this.failures.record(job, err);
  }

  /** Runs as the company that owns the purchase order (#239). */
  process(job: Job<ExportJob>) {
    return runJobAsCompany(
      `export ${job.data?.type}`,
      async () =>
        (
          await this.prisma.purchaseOrderHeader.findUnique({
            where: { id: job.data.purchaseOrderId },
            select: { shop: { select: { companyId: true } } },
          })
        )?.shop.companyId,
      () => this.handle(job),
      this.logger,
    );
  }

  private async handle(job: Job<ExportJob>): Promise<{ downloadUrl: string; fileName: string }> {
    const dir = this.config.get<string>('EXPORT_STORAGE_DIR', './storage/exports');
    await fs.mkdir(dir, { recursive: true });

    if (job.data.type === 'po-pdf') {
      const pdfResult = await this.documentPdf.renderPurchaseOrderPdfById(job.data.purchaseOrderId);
      const outPath = path.join(dir, pdfResult.filename);
      await fs.writeFile(outPath, pdfResult.buffer);
      return { downloadUrl: `/api/v1/export/files/${pdfResult.filename}`, fileName: pdfResult.filename };
    }

    this.logger.warn(`Unknown job type: ${JSON.stringify(job.data)}`);
    throw new Error('Unknown export job');
  }
}
