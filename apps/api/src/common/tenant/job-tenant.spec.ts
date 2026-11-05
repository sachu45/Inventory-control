import { runJobAsCompany } from './job-tenant';
import { TenantContext } from './tenant-context';

describe('runJobAsCompany', () => {
  it('runs the job as the owning company, resolving the owner with system access', async () => {
    let ownerCtx: ReturnType<typeof TenantContext.get>;
    const ctx = await runJobAsCompany(
      'job',
      async () => {
        ownerCtx = TenantContext.get();
        return 'c1';
      },
      async () => TenantContext.get(),
    );
    expect(ownerCtx).toMatchObject({ systemAccess: true });
    expect(ctx).toEqual({ companyId: 'c1', inRLSTx: false, systemAccess: false });
  });

  it('accepts an owner known up front', async () => {
    expect(await runJobAsCompany('job', () => 'c2', async () => TenantContext.get())).toMatchObject({ companyId: 'c2' });
  });

  it('falls back to system access, and says so, when there is no owner', async () => {
    const warn = jest.fn();
    const ctx = await runJobAsCompany('job x', async () => null, async () => TenantContext.get(), { warn });
    expect(ctx).toMatchObject({ companyId: null, systemAccess: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job x'));
  });

  it("propagates the job's error", async () => {
    await expect(runJobAsCompany('job', () => 'c1', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
