import { BillingController } from './billing.controller';

describe('Legacy payment endpoint capture enforcement', () => {
  function setup() {
    const razorpay = { verifyPaymentSignature: jest.fn().mockReturnValue(true), fetchCapturedPayment: jest.fn() };
    const subscriptions = { applyBoundPayment: jest.fn().mockResolvedValue(null), resolveCompanyIdForUser: jest.fn().mockResolvedValue('c1') };
    const prisma = { signupIntent: { findUnique: jest.fn().mockResolvedValue(null) }, subscriptionPayment: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', plan: 'PRO', amountPaise: 39900 }), update: jest.fn() } };
    return { controller: new BillingController(razorpay as any, subscriptions as any, prisma as any, {} as any, {} as any), razorpay, prisma };
  }
  const dto = { razorpay_order_id: 'order1', razorpay_payment_id: 'pay1', razorpay_signature: 'signature' };
  it('does not treat a checkout signature as proof that payment was captured', async () => {
    const { controller, razorpay, prisma } = setup(); razorpay.fetchCapturedPayment.mockRejectedValue(new Error('authorized only'));
    await expect(controller.verifyPayment(dto)).rejects.toThrow('not been captured'); expect(prisma.subscriptionPayment.update).not.toHaveBeenCalled();
  });
  it('verifies the stored order amount server-side before marking paid', async () => {
    const { controller, razorpay, prisma } = setup();
    await expect(controller.verifyPayment(dto)).resolves.toMatchObject({ ok: true });
    expect(razorpay.fetchCapturedPayment).toHaveBeenCalledWith('pay1', 'order1', 39900);
    expect(prisma.subscriptionPayment.update).toHaveBeenCalled();
  });
  it('rejects using an onboarding order through generic upgrade to bypass intent expiry', async () => {
    const { controller, prisma } = setup(); prisma.subscriptionPayment.findUnique.mockResolvedValue({ id: 'p1', plan: 'PRO', amountPaise: 39900, status: 'paid' } as any);
    prisma.signupIntent.findUnique.mockResolvedValue({ id: 'i1' } as any);
    await expect(controller.upgrade({ id: 'u1' } as any, dto)).rejects.toThrow('Google onboarding session');
  });
});
