import type { INestApplication } from '@nestjs/common';
import { BackupJobStatus, BackupProvider } from '@prisma/client';
import type { Job } from 'bullmq';
import { DispatchBatchService } from '../src/common/workflow-engine/dispatch/dispatch-batch.service';
import { DispatchProcessor } from '../src/common/workflow-engine/dispatch/dispatch.processor';
import { DISPATCH_JOB } from '../src/common/workflow-engine/dispatch/dispatch.constants';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { BackupProcessor } from '../src/modules/backup/backup.processor';
import { TenantBackupService } from '../src/modules/backup/tenant-backup.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { seedWorkflowMasterData } from './helpers/workflow-fixture';

const asJob = <T>(name: string, data: T) => ({ name, data, attemptsMade: 0 }) as unknown as Job<T>;

/** Background jobs run as the company they belong to, so RLS bounds them like a request (#239). */
describe('Background jobs run in their company tenant scope (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('backs a company up as that company, with only its rows', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const backupJob = await TenantContext.runWithSystemAccess(() =>
      prisma.backupJob.create({ data: { companyId: a.companyId, provider: BackupProvider.MANUAL, createdById: a.user.id } }),
    );

    const backups = app.get(TenantBackupService);
    const exportCompany = backups.exportCompany.bind(backups);
    let seen: ReturnType<typeof TenantContext.get>;
    let payload: Awaited<ReturnType<TenantBackupService['exportCompany']>> | undefined;
    jest.spyOn(backups, 'exportCompany').mockImplementation(async (companyId) => {
      seen = TenantContext.get();
      payload = await exportCompany(companyId);
      return payload;
    });

    await app.get(BackupProcessor).process(asJob('backup', { backupJobId: backupJob.id }));

    expect(seen).toMatchObject({ companyId: a.companyId, systemAccess: false });
    const json = JSON.stringify(payload);
    expect(json).toContain(a.shopId);
    expect(json).not.toContain(b.shopId);
    const done = await TenantContext.runWithSystemAccess(() => prisma.backupJob.findUniqueOrThrow({ where: { id: backupJob.id } }));
    expect(done.status).toBe(BackupJobStatus.COMPLETED);
  });

  it('flushes a dispatch batch as the company in the job', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    let seen: ReturnType<typeof TenantContext.get>;
    jest.spyOn(app.get(DispatchBatchService), 'collectPending').mockImplementation(async () => {
      seen = TenantContext.get();
      return [];
    });

    await app.get(DispatchProcessor).process(asJob(DISPATCH_JOB.FLUSH_BATCH, { companyId: a.companyId, customerId: a.customerId }));
    expect(seen).toMatchObject({ companyId: a.companyId, systemAccess: false });
  });

  it('falls back to system access when the job names no company', async () => {
    if (!E2E_DB_ENABLED) return;
    let seen: ReturnType<typeof TenantContext.get>;
    jest.spyOn(app.get(DispatchBatchService), 'collectPending').mockImplementation(async () => {
      seen = TenantContext.get();
      return [];
    });
    await app.get(DispatchProcessor).process(asJob(DISPATCH_JOB.FLUSH_BATCH, { customerId: 'x' }));
    expect(seen).toMatchObject({ systemAccess: true });
  });
});
