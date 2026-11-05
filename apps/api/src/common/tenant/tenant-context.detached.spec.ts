import { TenantContext } from './tenant-context';

describe('TenantContext.detached', () => {
  it('keeps the tenant scope but leaves the open transaction', async () => {
    const inner = await TenantContext.run({ companyId: 'c1', inRLSTx: true, systemAccess: false }, () =>
      TenantContext.detached(async () => TenantContext.get()),
    );
    expect(inner).toEqual({ companyId: 'c1', inRLSTx: false, systemAccess: false });
  });

  it('keeps system access', async () => {
    const inner = await TenantContext.run({ companyId: null, inRLSTx: true, systemAccess: true }, () =>
      TenantContext.detached(async () => TenantContext.get()),
    );
    expect(inner).toEqual({ companyId: null, inRLSTx: false, systemAccess: true });
  });

  it('changes nothing outside a transaction or without a context', async () => {
    const ctx = { companyId: 'c1', inRLSTx: false, systemAccess: false };
    expect(await TenantContext.run(ctx, () => TenantContext.detached(async () => TenantContext.get()))).toBe(ctx);
    expect(await TenantContext.exit(() => TenantContext.detached(async () => TenantContext.get()))).toBeUndefined();
  });
});
