import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { BillingCycle, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, login, unwrap } from './helpers/e2e-http';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@retailims.com';

type Dashboard = {
  kpis: { totalTrials: number; paidSubscribers: number };
  failedPayments: { id: string; companyName: string }[];
};

/**
 * Platform admins act across every tenant, but their own request runs in their
 * own company's RLS context. These routes must still see all companies.
 */
describe('Platform subscriptions across tenants (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const created: string[] = [];
  let failedPaymentId: string;
  const previousAllowlist = process.env.PLATFORM_ADMIN_EMAILS;

  const createCompany = async (plan: SubscriptionPlan) => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    const company = await prisma.company.create({
      data: {
        companyCode: `PS-${tag}`,
        companyName: `Platform subs ${tag}`,
        subscriptionPlan: plan,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        billingCycle: plan === SubscriptionPlan.TRIAL ? null : BillingCycle.MONTHLY,
        trialEndsAt: plan === SubscriptionPlan.TRIAL ? new Date(Date.now() + 3 * 24 * 3600 * 1000) : null,
        subscriptionEndsAt: plan === SubscriptionPlan.TRIAL ? null : new Date(Date.now() + 20 * 24 * 3600 * 1000),
      },
    });
    created.push(company.id);
    return company;
  };

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    token = (await login(app)).accessToken;

    await createCompany(SubscriptionPlan.TRIAL);
    await createCompany(SubscriptionPlan.TRIAL);
    const paid = await createCompany(SubscriptionPlan.PRO);
    failedPaymentId = (
      await prisma.subscriptionPayment.create({
        data: {
          companyId: paid.id,
          plan: SubscriptionPlan.PRO,
          billingCycle: BillingCycle.MONTHLY,
          amountPaise: 39900,
          razorpayOrderId: `order_${randomUUID()}`,
          status: 'failed',
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = previousAllowlist;
    await prisma.subscriptionPayment.deleteMany({ where: { id: failedPaymentId } });
    await prisma.company.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  it("dashboard counts every tenant, not just the admin's own company", async () => {
    if (!E2E_DB_ENABLED) return;
    // Outside a request the test client has system access, so this is the true count.
    const [trials, paid] = await Promise.all([
      prisma.company.count({ where: { isActive: true, subscriptionPlan: SubscriptionPlan.TRIAL } }),
      prisma.company.count({
        where: {
          isActive: true,
          subscriptionPlan: { in: [SubscriptionPlan.PRO, SubscriptionPlan.PLUS] },
          subscriptionStatus: SubscriptionStatus.ACTIVE,
        },
      }),
    ]);
    expect(trials).toBeGreaterThanOrEqual(2);

    const dashboard = unwrap<Dashboard>(
      (await authed(app, token).get('/api/v1/platform/subscriptions/dashboard').expect(200)).body,
    );
    expect(dashboard.kpis.totalTrials).toBe(trials);
    expect(dashboard.kpis.paidSubscribers).toBe(paid);
    expect(dashboard.failedPayments.find((p) => p.id === failedPaymentId)?.companyName).toMatch(/^Platform subs /);
  });

  it('backfills invoices for every paid tenant', async () => {
    if (!E2E_DB_ENABLED) return;
    const paidCompanies = await prisma.company.count({
      where: { isActive: true, subscriptionPlan: { in: [SubscriptionPlan.PRO, SubscriptionPlan.PLUS] } },
    });
    expect(paidCompanies).toBeGreaterThanOrEqual(1);
    const result = unwrap<{ companies: number }>(
      (await authed(app, token).post('/api/v1/platform/subscriptions/backfill-invoices').expect(201)).body,
    );
    expect(result.companies).toBe(paidCompanies);
  });
});
