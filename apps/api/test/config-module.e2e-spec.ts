import { randomUUID } from 'crypto';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ConfigDraftService } from '../src/common/config/config-draft.service';
import { ConfigPublishService } from '../src/common/config/config-publish.service';
import { ConfigResolverService } from '../src/common/config/config-resolver.service';
import { ModuleRegistryService } from '../src/common/config/module-registry.service';
import { UserPreferenceService } from '../src/common/config/user-preference.service';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Boots the real AppModule with TenantConfigModule registered and drives the
 * config services through it. Skips itself when DATABASE_URL is absent.
 */
describe('TenantConfigModule in AppModule (e2e)', () => {
  const enabled = Boolean(process.env.DATABASE_URL);
  let app: INestApplication;
  let prisma: PrismaService;
  let drafts: ConfigDraftService;
  let publisher: ConfigPublishService;
  let resolver: ConfigResolverService;
  let preferences: UserPreferenceService;
  let actorId: string;
  const companies: string[] = [];

  const createCompany = async () => {
    const companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await prisma.company.create({ data: { id: companyId, companyCode: `CM-${tag}`, companyName: `cm ${tag}` } });
    const shop = await prisma.shop.create({
      data: {
        companyId,
        shopNumber: `CM-${tag}`,
        shopName: 'cm shop',
        address: 'n/a',
        contactPerson: 'n/a',
        mobile: '0000000000',
        email: `cm-${tag}@example.test`,
      },
    });
    companies.push(companyId);
    return { companyId, shopId: shop.id };
  };

  const asTenant = <T>(companyId: string, fn: () => Promise<T>) =>
    TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, fn);

  beforeAll(async () => {
    if (!enabled) return;
    // Started outside any TenantContext, as in production (see helpers/system-access.ts).
    const moduleRef = await TenantContext.exit(() => Test.createTestingModule({ imports: [AppModule] }).compile());
    app = moduleRef.createNestApplication();
    await TenantContext.exit(() => app.init());
    prisma = app.get(PrismaService);
    drafts = app.get(ConfigDraftService);
    publisher = app.get(ConfigPublishService);
    resolver = app.get(ConfigResolverService);
    preferences = app.get(UserPreferenceService);
    actorId = (await prisma.user.findFirstOrThrow({ select: { id: true } })).id;
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.company.deleteMany({ where: { id: { in: companies } } });
    await app.close();
  });

  it('boots with every config provider available', () => {
    if (!enabled) return;
    expect(app.get(ModuleRegistryService).all()).toHaveLength(29);
  });

  it('draft edits are validated, revision-checked, and only go live on publish', async () => {
    if (!enabled) return;
    const { companyId, shopId } = await createCompany();
    const other = await createCompany();

    await expect(drafts.create({ companyId, moduleKey: 'ghost', actorId })).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    await expect(
      drafts.create({ companyId, moduleKey: 'purchase-orders', config: { hiddenFields: ['supplier'] }, actorId }),
    ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY });
    await expect(
      drafts.create({ companyId, shopId: other.shopId, moduleKey: 'contracts', enabled: false, actorId }),
    ).rejects.toMatchObject({ details: [{ path: 'shopId', message: 'Shop does not belong to this company' }] });

    const row = await drafts.create({ companyId, moduleKey: 'contracts', enabled: false, actorId });
    expect(row).toMatchObject({ revision: 1, enabled: false, updatedBy: actorId });
    await expect(drafts.create({ companyId, moduleKey: 'contracts', actorId })).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: { code: 'CONFIG_DRAFT_EXISTS' },
    });
    await drafts.create({ companyId, shopId, moduleKey: 'rfqs', enabled: false, actorId });

    const updated = await drafts.update({ companyId, id: row.id, expectedRevision: 1, config: { label: 'Agreements' }, actorId });
    expect(updated).toMatchObject({ revision: 2, enabled: false, config: { label: 'Agreements' } });
    await expect(drafts.update({ companyId, id: row.id, expectedRevision: 1, enabled: true, actorId })).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: { code: 'CONFIG_DRAFT_REVISION_CONFLICT', details: { expectedRevision: 1, currentRevision: 2 } },
    });
    await expect(
      drafts.update({ companyId: other.companyId, id: row.id, expectedRevision: 2, enabled: true, actorId }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });

    expect((await asTenant(companyId, () => resolver.resolve())).version).toBe(0);
    await publisher.publish({ companyId, expectedBaseVersion: 0, actorId });
    const live = await asTenant(companyId, () => resolver.resolve({ shopId }));
    expect(live.version).toBe(1);
    expect(live.modules.contracts).toEqual({ enabled: false, config: { mandatoryFields: [], hiddenFields: [], label: 'Agreements' } });
    expect(live.modules.rfqs.enabled).toBe(false);

    await expect(drafts.remove({ companyId, id: row.id, expectedRevision: 1 })).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
    await drafts.remove({ companyId, id: row.id, expectedRevision: 2 });
    expect((await drafts.list(companyId)).map((d) => d.moduleKey)).toEqual(['rfqs']);
  });

  it('stores preferences for the tenant company and never hides mandatory columns', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    await drafts.create({ companyId, moduleKey: 'purchase-orders', config: { mandatoryFields: ['remarks'] }, actorId });
    await publisher.publish({ companyId, expectedBaseVersion: 0, actorId });

    await asTenant(companyId, async () => {
      await expect(preferences.set(actorId, 'nonsense', {})).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      await expect(preferences.set(actorId, 'purchase-orders', { enabled: false })).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });

      await preferences.set(actorId, 'purchase-orders', { hiddenColumns: ['remarks', 'lineCategory'] });
      await preferences.set(actorId, 'sidebar', { pinned: ['sales'] });
      expect(await preferences.get(actorId)).toEqual({
        'purchase-orders': { hiddenColumns: ['lineCategory'] },
        sidebar: { pinned: ['sales'] },
      });

      await preferences.set(actorId, 'sidebar', { pinned: ['invoices'] });
      expect((await preferences.get(actorId)).sidebar).toEqual({ pinned: ['invoices'] });
    });

    const stored = await prisma.userPreference.findMany({ where: { userId: actorId, companyId } });
    expect(stored).toHaveLength(2);
    await expect(preferences.set(actorId, 'sidebar', {})).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });
});
