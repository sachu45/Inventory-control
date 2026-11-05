import { OnboardingBillingService } from './onboarding-billing.service';

describe('Onboarding payment integrity', () => {
  function setup(overrides = {}) {
    const intent = { id: 'i1', status: 'PAYMENT_PENDING', companyId: 'c1', userId: 'u1', orderId: 'order1', amountPaise: 39900, plan: 'PRO', billingCycle: 'MONTHLY', securityVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 3600000), ...overrides };
    const prisma = { signupIntent: { findUnique: jest.fn().mockResolvedValue(intent), findUniqueOrThrow: jest.fn().mockResolvedValue(intent), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { findUnique: jest.fn().mockResolvedValue({ isActive: true, role: { name: 'OWNER' }, shop: { companyId: 'c1' } }), update: jest.fn() },
      company: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'c1', isActive: true, subscriptionPlan: 'TRIAL' }), update: jest.fn() },
      subscriptionPayment: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue({ status: 'paid', razorpayPaymentId: 'pay1' }), findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn(), $transaction: jest.fn() };
    prisma.$transaction.mockImplementation(work => work(prisma));
    const razorpay = { isConfigured: () => true, keyId: () => 'rzp_test', createOrder: jest.fn().mockResolvedValue({ orderId: 'neworder', amount: 39900, currency: 'INR' }), verifyPaymentSignature: jest.fn().mockReturnValue(true), fetchCapturedPayment: jest.fn().mockResolvedValue({ status: 'captured' }) };
    const subscriptions = { clearWriteBlockCache: jest.fn() };
    return { service: new OnboardingBillingService(prisma as any, razorpay as any, subscriptions as any, { resolveOwnerEmail: jest.fn().mockResolvedValue(null) } as any), prisma, razorpay, intent };
  }
  it('reuses an existing order rather than creating a duplicate charge', async () => {
    const { service, razorpay } = setup(); await expect(service.checkout('i1')).resolves.toMatchObject({ order_id: 'order1', amount: 39900 }); expect(razorpay.createOrder).not.toHaveBeenCalled();
  });
  it('creates a workspace-bound order using only the stored amount and plan', async () => {
    const { service, prisma, razorpay } = setup({ orderId: null, status: 'CHECKOUT_PENDING' }); await service.checkout('i1');
    expect(razorpay.createOrder).toHaveBeenCalledWith(expect.objectContaining({ amountPaise: 39900 }));
    expect(prisma.subscriptionPayment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ companyId: 'c1', plan: 'PRO', amountPaise: 39900 }) });
  });
  it.each([{ expiresAt: new Date(0) }, { companyId: null }, { securityVerifiedAt: null }, { status: 'FAILED' }])('rejects invalid checkout state %j', async (invalid) => {
    const { service, razorpay } = setup(invalid); await expect(service.checkout('i1')).rejects.toThrow('unavailable'); expect(razorpay.createOrder).not.toHaveBeenCalled();
  });
  it('rejects a payment from another signup order', async () => {
    const { service, razorpay } = setup(); await expect(service.verify('i1', 'other', 'pay1', 'signature')).rejects.toThrow('verification'); expect(razorpay.fetchCapturedPayment).not.toHaveBeenCalled();
  });
  it('rejects an invalid checkout signature', async () => {
    const { service, razorpay } = setup(); razorpay.verifyPaymentSignature.mockReturnValue(false); await expect(service.verify('i1', 'order1', 'pay1', 'bad')).rejects.toThrow('verification');
  });
  it('requires captured payment status, currency, amount and order from Razorpay', async () => {
    const { service, razorpay, prisma } = setup(); razorpay.fetchCapturedPayment.mockRejectedValue(new Error('Not captured'));
    await expect(service.capture('order1', 'pay1')).rejects.toThrow('Not captured'); expect(prisma.company.update).not.toHaveBeenCalled();
    expect(razorpay.fetchCapturedPayment).toHaveBeenCalledWith('pay1', 'order1', 39900);
  });
  it('activates only after an atomic claim and binding checks', async () => {
    const { service, prisma } = setup(); await service.capture('order1', 'pay1');
    expect(prisma.subscriptionPayment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: 'c1', plan: 'PRO', billingCycle: 'MONTHLY', amountPaise: 39900, consumedAt: null }) }));
    expect(prisma.company.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ subscriptionPlan: 'PRO', subscriptionStatus: 'ACTIVE' }) }));
  });
  it('accepts duplicate captured webhooks without extending access twice', async () => {
    const { service, prisma } = setup({ status: 'SUBSCRIPTION_ACTIVE' }); await expect(service.capture('order1', 'pay1')).resolves.toBe(true); expect(prisma.company.update).not.toHaveBeenCalled();
  });
  it('rejects replay with a different payment reference', async () => {
    const { service, prisma } = setup({ status: 'SUBSCRIPTION_ACTIVE' }); prisma.subscriptionPayment.findUnique.mockResolvedValue({ status: 'paid', razorpayPaymentId: 'different' });
    await expect(service.capture('order1', 'pay1')).rejects.toThrow('mismatch'); expect(prisma.company.update).not.toHaveBeenCalled();
  });
  it('does not activate expired, cancelled or already consumed transactions', async () => {
    const { service, prisma } = setup({ status: 'EXPIRED' }); prisma.signupIntent.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.capture('order1', 'pay1')).rejects.toThrow('expired'); expect(prisma.company.update).not.toHaveBeenCalled();
  });
  it('rejects cross-tenant membership after payment', async () => {
    const { service, prisma } = setup(); prisma.user.findUnique.mockResolvedValue({ isActive: true, role: { name: 'OWNER' }, shop: { companyId: 'other' } });
    await expect(service.capture('order1', 'pay1')).rejects.toThrow('membership'); expect(prisma.company.update).not.toHaveBeenCalled();
  });
  it('rejects a plan downgrade instead of applying a tampered association', async () => {
    const { service, prisma } = setup(); prisma.company.findUniqueOrThrow.mockResolvedValue({ id: 'c1', isActive: true, subscriptionPlan: 'PLUS' });
    await expect(service.capture('order1', 'pay1')).rejects.toThrow('plan'); expect(prisma.company.update).not.toHaveBeenCalled();
  });

  it('suspends the latest entitlement purchase after a verified refund', async () => {
    const { service, prisma } = setup(); prisma.subscriptionPayment.findFirst.mockResolvedValue({ id: 'p1', razorpayOrderId: 'order1' });
    await service.refund('pay1');
    expect(prisma.company.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { subscriptionStatus: 'SUSPENDED' } });
    expect(prisma.signupIntent.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'CANCELLED' } });
  });
  it('does not suspend a later purchase when an older payment is refunded', async () => {
    const { service, prisma } = setup(); prisma.subscriptionPayment.findFirst.mockResolvedValueOnce({ id: 'older', razorpayOrderId: 'order1' }).mockResolvedValueOnce({ id: 'newer' });
    await service.refund('pay1'); expect(prisma.company.update).not.toHaveBeenCalled();
  });
  it('ignores duplicate refund deliveries', async () => {
    const { service, prisma } = setup(); prisma.subscriptionPayment.findFirst.mockResolvedValue({ id: 'p1', razorpayOrderId: 'order1' }); prisma.subscriptionPayment.updateMany.mockResolvedValue({ count: 0 });
    await service.refund('pay1'); expect(prisma.company.update).not.toHaveBeenCalled();
  });
});
