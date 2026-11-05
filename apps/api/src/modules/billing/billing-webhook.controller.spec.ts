import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { BillingWebhookController } from './billing-webhook.controller';
import { RazorpayService } from './razorpay.service';

describe('Signed onboarding webhook dispatch', () => {
  function setup() {
    const razorpay = new RazorpayService(new ConfigService({ RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret' }));
    const onboarding = { capture: jest.fn().mockResolvedValue(true), refund: jest.fn() };
    const controller = new BillingWebhookController(razorpay, {} as any, {} as any, {} as any, {} as any, onboarding as any);
    return { controller, onboarding };
  }
  function request(event = 'payment.captured') {
    const body = { event, payload: { payment: { entity: { id: 'pay1', order_id: 'order1' } }, refund: { entity: { payment_id: 'pay1' } } } };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = createHmac('sha256', 'test-webhook-secret').update(rawBody).digest('hex');
    return { req: { body, rawBody }, signature };
  }
  it('dispatches an authentic captured event to the bound onboarding verifier', async () => {
    const { controller, onboarding } = setup(); const { req, signature } = request();
    await expect(controller.handleRazorpay(req as any, signature)).resolves.toEqual({ ok: true });
    expect(onboarding.capture).toHaveBeenCalledWith('order1', 'pay1');
  });
  it('rejects a tampered signature before any activation', async () => {
    const { controller, onboarding } = setup(); const { req } = request();
    await expect(controller.handleRazorpay(req as any, 'tampered')).rejects.toThrow('signature');
    expect(onboarding.capture).not.toHaveBeenCalled();
  });
  it('requires the signed raw body rather than reserialized JSON', async () => {
    const { controller, onboarding } = setup(); const { req, signature } = request();
    await expect(controller.handleRazorpay({ body: req.body } as any, signature)).rejects.toThrow('raw');
    expect(onboarding.capture).not.toHaveBeenCalled();
  });
  it('only dispatches refund processing after signature verification', async () => {
    const { controller, onboarding } = setup(); const { req, signature } = request('refund.processed');
    await controller.handleRazorpay(req as any, signature);
    expect(onboarding.refund).toHaveBeenCalledWith('pay1');
  });
});
