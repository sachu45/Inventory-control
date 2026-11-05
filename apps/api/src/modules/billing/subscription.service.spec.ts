import { BillingCycle, SubscriptionPlan } from '@prisma/client';
import { SubscriptionService } from './subscription.service';

describe('SubscriptionService.applyBoundPayment', () => {
  function setup(payment: Record<string, unknown> | null) {
    const prisma = {
      signupIntent: { findUnique: jest.fn().mockResolvedValue(null) },
      subscriptionPayment: { findUnique: jest.fn().mockResolvedValue(payment) },
    } as any;
    const service = new SubscriptionService(prisma);
    const activate = jest.spyOn(service, 'activatePaidPlan').mockResolvedValue(undefined);
    return { service, activate };
  }

  const paid = {
    companyId: 'c1',
    status: 'paid',
    consumedAt: null,
    plan: SubscriptionPlan.PRO,
    billingCycle: BillingCycle.MONTHLY,
    amountPaise: 99900,
  };

  it('activates the plan for the organisation the order was created for', async () => {
    const { service, activate } = setup(paid);
    await expect(service.applyBoundPayment('order_1', 'pay_1')).resolves.toBe('c1');
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'c1', orderId: 'order_1', paymentId: 'pay_1', plan: SubscriptionPlan.PRO }),
    );
  });

  it.each([
    ['unbound (signup) orders', { ...paid, companyId: null }],
    ['already consumed orders', { ...paid, consumedAt: new Date() }],
    ['unpaid orders', { ...paid, status: 'created' }],
    ['unknown orders', null],
  ])('leaves %s alone', async (_label, payment) => {
    const { service, activate } = setup(payment);
    await expect(service.applyBoundPayment('order_1', 'pay_1')).resolves.toBeNull();
    expect(activate).not.toHaveBeenCalled();
  });

  it('returns null when a concurrent request already applied it', async () => {
    const { service, activate } = setup(paid);
    const { BadRequestException } = require('@nestjs/common');
    activate.mockRejectedValue(new BadRequestException('Payment already consumed by a concurrent request'));
    await expect(service.applyBoundPayment('order_1', 'pay_1')).resolves.toBeNull();
  });
});

describe('Subscription entitlement state enforcement', () => {
  const company = (extra = {}) => ({ subscriptionPlan: 'PLUS', subscriptionStatus: 'ACTIVE', billingCycle: 'MONTHLY', trialStartsAt: null, trialEndsAt: null, subscriptionEndsAt: new Date(Date.now() + 86400000), ...extra });
  it.each(['SUSPENDED', 'EXPIRED'])('removes paid feature flags for %s subscriptions', status => {
    const service = new SubscriptionService({} as any);
    const snapshot = service.toSnapshot(company({ subscriptionStatus: status }) as any);
    expect(Object.values(snapshot.features).every(enabled => enabled === false)).toBe(true);
  });
  it('enforces suspension on the backend even if the browser claims a paid plan', async () => {
    const service = new SubscriptionService({ company: { findUnique: jest.fn().mockResolvedValue(company({ subscriptionStatus: 'SUSPENDED' })) } } as any);
    await expect(service.assertFeature('company', 'reports')).rejects.toThrow();
  });
  it('blocks paid entitlements after the existing expiration grace period', async () => {
    const expired = company({ subscriptionEndsAt: new Date(0) });
    const service = new SubscriptionService({ company: { findUnique: jest.fn().mockResolvedValue(expired) } } as any);
    expect(service.toSnapshot(expired as any).features.api).toBe(false);
    await expect(service.assertFeature('company', 'reports')).rejects.toThrow();
  });
});
