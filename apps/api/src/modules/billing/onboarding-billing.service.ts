import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { isDowngrade, subscriptionEndDate } from '../../common/plans/plan-config';
import { RazorpayService } from './razorpay.service';
import { SubscriptionService } from './subscription.service';
import { LifecycleOrchestratorService } from '../subscription-lifecycle/lifecycle-orchestrator.service';
import { notifySubscriptionActivated } from './notify-activation';

@Injectable()
export class OnboardingBillingService {
  private readonly logger = new Logger(OnboardingBillingService.name);
  constructor(private readonly prisma: PrismaService, private readonly razorpay: RazorpayService, private readonly subscriptions: SubscriptionService, private readonly lifecycle: LifecycleOrchestratorService) {}

  async checkout(intentId: string) {
    if (!this.razorpay.isConfigured()) throw new BadRequestException('Payment gateway is not configured.');
    return this.prisma.$transaction(async tx => {
      // Serialize checkout creation. Concurrent clicks reuse the same order.
      await tx.$queryRaw`SELECT id FROM signup_intents WHERE id = ${intentId}::uuid FOR UPDATE`;
      const intent = await tx.signupIntent.findUniqueOrThrow({ where: { id: intentId } });
      if (intent.loginOnly || !intent.companyId || !intent.userId || !intent.securityVerifiedAt || intent.expiresAt <= new Date() || !['CHECKOUT_PENDING', 'PAYMENT_PENDING'].includes(intent.status)) throw new BadRequestException('Checkout is unavailable or expired.');
      const orderId = intent.orderId;
      if (orderId) return { order_id: orderId, amount: intent.amountPaise, currency: 'INR', key_id: this.razorpay.keyId() };
      const order = await this.razorpay.createOrder({ amountPaise: intent.amountPaise, receipt: `onb_${randomUUID().replace(/-/g, '').slice(0, 24)}` });
      if (order.amount !== intent.amountPaise || order.currency !== 'INR') throw new BadRequestException('Payment provider returned an unexpected amount.');
      await tx.subscriptionPayment.create({ data: { companyId: intent.companyId, plan: intent.plan, billingCycle: intent.billingCycle, amountPaise: intent.amountPaise, razorpayOrderId: order.orderId, status: 'created' } });
      await tx.signupIntent.update({ where: { id: intent.id }, data: { orderId: order.orderId, status: 'PAYMENT_PENDING' } });
      return { order_id: order.orderId, amount: order.amount, currency: order.currency, key_id: this.razorpay.keyId() };
    }, { timeout: 20000 });
  }

  async verify(intentId: string, orderId: string, paymentId: string, signature: string) {
    const intent = await this.prisma.signupIntent.findUniqueOrThrow({ where: { id: intentId } });
    if (intent.orderId !== orderId || !this.razorpay.verifyPaymentSignature({ orderId, paymentId, signature })) throw new BadRequestException('Payment verification failed.');
    await this.capture(orderId, paymentId);
    return { ok: true };
  }

  async capture(orderId: string, paymentId: string) {
    const intent = await this.prisma.signupIntent.findUnique({ where: { orderId } });
    if (!intent) return false;
    // Verify with Razorpay server-to-server, including webhook deliveries.
    await this.razorpay.fetchCapturedPayment(paymentId, orderId, intent.amountPaise);
    if (intent.status === 'SUBSCRIPTION_ACTIVE') {
      const paid = await this.prisma.subscriptionPayment.findUnique({ where: { razorpayOrderId: orderId } });
      if (paid?.razorpayPaymentId !== paymentId || paid.status !== 'paid') throw new ConflictException('Payment reference mismatch.');
      return true;
    }
    const activated = await this.prisma.$transaction(async tx => {
      const claimed = await tx.signupIntent.updateMany({ where: { id: intent.id, status: 'PAYMENT_PENDING', expiresAt: { gt: new Date() }, securityVerifiedAt: { not: null } }, data: { status: 'PAYMENT_VERIFIED' } });
      if (!claimed.count) {
        const current = await tx.signupIntent.findUniqueOrThrow({ where: { id: intent.id } });
        if (current.status === 'SUBSCRIPTION_ACTIVE') return false;
        throw new ConflictException('Payment transaction expired or is no longer available. Contact support if you were charged.');
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${intent.userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: intent.userId! }, include: { role: true, shop: true } });
      if (!user?.isActive || user.deletedAt || user.shop?.companyId !== intent.companyId || !['OWNER', 'ADMIN'].includes(user.role.name)) throw new BadRequestException('Invalid workspace membership.');
      await tx.$queryRaw`SELECT id FROM companies WHERE id = ${intent.companyId}::uuid FOR UPDATE`;
      const company = await tx.company.findUniqueOrThrow({ where: { id: intent.companyId! } });
      if (!company.isActive || isDowngrade(company.subscriptionPlan, intent.plan)) throw new BadRequestException('Selected plan cannot be applied to this workspace.');
      const now = new Date();
      const payment = await tx.subscriptionPayment.updateMany({ where: { razorpayOrderId: orderId, companyId: intent.companyId, plan: intent.plan, billingCycle: intent.billingCycle, amountPaise: intent.amountPaise, consumedAt: null, status: { notIn: ['refunded', 'cancelled'] } }, data: { razorpayPaymentId: paymentId, verifiedAt: now, consumedAt: now, status: 'paid', failureReason: null } });
      if (payment.count !== 1) throw new ConflictException('Payment already used or does not match this signup.');
      const renewalStart = company.subscriptionPlan === intent.plan && company.subscriptionEndsAt && company.subscriptionEndsAt > now ? company.subscriptionEndsAt : now;
      await tx.company.update({ where: { id: company.id }, data: { subscriptionPlan: intent.plan, billingCycle: intent.billingCycle, subscriptionStatus: 'ACTIVE', subscriptionEndsAt: subscriptionEndDate(intent.plan, intent.billingCycle, renewalStart), trialEndsAt: null, paidActivatedAt: company.paidActivatedAt ?? now } });
      await tx.signupIntent.update({ where: { id: intent.id }, data: { status: 'SUBSCRIPTION_ACTIVE' } });
      await tx.user.update({ where: { id: intent.userId! }, data: { onboardingRequired: false } });
      return true;
    });
    this.subscriptions.clearWriteBlockCache(intent.companyId!);
    if (activated) {
      const payment = await this.prisma.subscriptionPayment.findUnique({ where: { razorpayOrderId: orderId } });
      if (payment) await notifySubscriptionActivated(this.lifecycle, intent.companyId!, payment).catch(() => this.logger.warn('Activation notification could not be queued.'));
    }
    return true;
  }

  async refund(paymentId: string) {
    // Signed refund events suspend only the most recent entitlement purchase.
    const payment = await this.prisma.subscriptionPayment.findFirst({ where: { razorpayPaymentId: paymentId } });
    if (!payment) return;
    const intent = await this.prisma.signupIntent.findUnique({ where: { orderId: payment.razorpayOrderId } });
    if (!intent?.companyId) return;
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.subscriptionPayment.updateMany({ where: { id: payment.id, status: { not: 'refunded' } }, data: { status: 'refunded' } });
      if (!claimed.count) return;
      await tx.signupIntent.update({ where: { id: intent.id }, data: { status: 'CANCELLED' } });
      const latest = await tx.subscriptionPayment.findFirst({ where: { companyId: intent.companyId, consumedAt: { not: null } }, orderBy: { consumedAt: 'desc' } });
      if (latest?.id === payment.id) await tx.company.update({ where: { id: intent.companyId! }, data: { subscriptionStatus: 'SUSPENDED' } });
    });
    this.subscriptions.clearWriteBlockCache(intent.companyId);
  }
}
