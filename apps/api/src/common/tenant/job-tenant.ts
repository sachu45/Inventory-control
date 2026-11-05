import type { Logger } from '@nestjs/common';
import { TenantContext } from './tenant-context';

/**
 * Runs a background job as the company that owns it, so RLS bounds what the
 * job can read and write to that company, as it does for a request (#239).
 *
 * `owner` finds the company (with system access, since nothing is scoped yet),
 * usually from the job payload or the row the job is about. When it finds none
 * (the row is gone, or the job is not about one company) the job runs with
 * system access as before, and that is logged.
 */
export async function runJobAsCompany<T>(
  label: string,
  owner: () => Promise<string | null | undefined> | string | null | undefined,
  fn: () => Promise<T>,
  logger?: Pick<Logger, 'warn'>,
): Promise<T> {
  const companyId = await TenantContext.runWithSystemAccess(async () => (await owner()) ?? null);
  if (!companyId) {
    logger?.warn(`${label}: no owning company found; running with system access`);
    return TenantContext.runWithSystemAccess(fn);
  }
  return TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => await fn());
}
