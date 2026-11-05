import { ConfigService } from '@nestjs/config';
import { GoogleOnboardingService } from './google-onboarding.service';
import { hashOAuthValue } from './google-identity.service';

describe('Google onboarding guardrails', () => {
  const base = () => ({ id: 'i1', status: 'OAUTH_PENDING', loginOnly: false, sessionHash: hashOAuthValue('browser'), stateHash: hashOAuthValue('state'), nonceHash: hashOAuthValue('nonce'), pkceVerifier: 'verifier', expiresAt: new Date(Date.now() + 3600000), oauthExpiresAt: new Date(Date.now() + 600000), plan: 'PRO', billingCycle: 'MONTHLY', amountPaise: 39900, userId: null, companyId: null, orderId: null, securityVerifiedAt: null });
  function setup(overrides = {}) {
    const intent = { ...base(), ...overrides };
    const prisma = {
      signupIntent: { findUnique: jest.fn().mockResolvedValue(intent), findUniqueOrThrow: jest.fn().mockResolvedValue(intent), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn() },
      oAuthAccount: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue(null), findUniqueOrThrow: jest.fn(), create: jest.fn() },
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'owner-role' }) },
      company: { findUniqueOrThrow: jest.fn(), create: jest.fn() }, shop: { create: jest.fn() }, userConsent: { create: jest.fn() },
      subscriptionPayment: { findUnique: jest.fn() }, authChallenge: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(work => work(prisma));
    const google = { settings: jest.fn(), authorizationUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth'), exchange: jest.fn().mockResolvedValue({ subject: 'subject', email: 'owner@example.com', name: 'Person', picture: null }) };
    const auth = { validateCredentials: jest.fn(), issueSessionForUser: jest.fn() };
    const mfa = { createLoginChallenge: jest.fn(), startAccountEnrollment: jest.fn(), verifyAccountEnrollment: jest.fn() };
    const service = new GoogleOnboardingService(prisma as any, new ConfigService({}), google as any, auth as any, mfa as any);
    return { service, prisma, google, auth, intent, mfa };
  }
  it.each([['pro', 'monthly', 'PRO', 39900], ['plus', 'yearly', 'PLUS', 658800]] as const)('stores server-priced %s/%s intent', async (plan, billing, storedPlan, amountPaise) => {
    const { service, prisma } = setup();
    const result = await service.start({ plan, billing });
    expect(prisma.signupIntent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ plan: storedPlan, amountPaise, sessionHash: hashOAuthValue(result.session) }) });
  });
  it('rejects invalid plans without creating an intent', async () => {
    const { service, prisma } = setup();
    await expect(service.start({ plan: 'enterprise' as any })).rejects.toThrow('Pro or Plus');
    expect(prisma.signupIntent.create).not.toHaveBeenCalled();
  });
  it('fails safely before storing intents when Google is unconfigured', async () => {
    const { service, google, prisma } = setup(); google.settings.mockImplementation(() => { throw new Error('Not configured'); });
    await expect(service.start({ plan: 'pro' })).rejects.toThrow(); expect(prisma.signupIntent.create).not.toHaveBeenCalled();
  });
  it('rejects expired browser intents', async () => {
    const { service, prisma } = setup({ expiresAt: new Date(0) });
    await expect(service.intent('browser')).rejects.toThrow('expired');
    expect(prisma.signupIntent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'EXPIRED', pkceVerifier: null } }));
  });
  it('rejects wrong state before exchanging the code', async () => {
    const { service, google } = setup(); await expect(service.callback('browser', 'wrong', 'code')).rejects.toThrow('Invalid'); expect(google.exchange).not.toHaveBeenCalled();
  });
  it('rejects an expired OAuth exchange even if the browser intent remains valid', async () => {
    const { service, google } = setup({ oauthExpiresAt: new Date(0) }); await expect(service.callback('browser', 'state', 'code')).rejects.toThrow('expired'); expect(google.exchange).not.toHaveBeenCalled();
  });
  it('handles cancellation without account creation', async () => {
    const { service, prisma, google } = setup(); await expect(service.callback('browser', 'state', undefined, 'access_denied')).rejects.toThrow('cancelled'); expect(google.exchange).not.toHaveBeenCalled(); expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it('rejects duplicate callbacks before exchanging the code', async () => {
    const { service, prisma, google } = setup(); prisma.signupIntent.updateMany.mockResolvedValue({ count: 0 }); await expect(service.callback('browser', 'state', 'code')).rejects.toThrow('already processed'); expect(google.exchange).not.toHaveBeenCalled();
  });
  it('requires explicit existing-password proof instead of auto-linking matching email', async () => {
    const { service, prisma } = setup(); prisma.user.findUnique.mockResolvedValue({ id: 'existing' });
    await service.callback('browser', 'state', 'code'); expect(prisma.oAuthAccount.create).not.toHaveBeenCalled(); expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it('reuses an existing subject without creating another user', async () => {
    const { service, prisma } = setup(); const user = { id: 'u1', isActive: true, deletedAt: null, shopId: 's1', shop: { companyId: 'c1' }, role: { name: 'OWNER' } };
    prisma.oAuthAccount.findUnique.mockResolvedValue({ userId: 'u1', user }); prisma.user.findUniqueOrThrow.mockResolvedValue(user);
    await service.callback('browser', 'state', 'code'); expect(prisma.user.create).not.toHaveBeenCalled(); expect(prisma.signupIntent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', companyId: 'c1' }) }));
  });
  it('creates a Google-only user without creating a company from their profile name', async () => {
    const { service, prisma } = setup(); const user = { id: 'u1', isActive: true, shopId: null, role: { name: 'OWNER' } }; prisma.user.create.mockResolvedValue(user); prisma.user.findUniqueOrThrow.mockResolvedValue(user);
    await service.callback('browser', 'state', 'code'); expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'owner@example.com', roleId: 'owner-role' }) })); expect(prisma.company.create).not.toHaveBeenCalled();
  });
  it('does not link an account with incorrect credentials', async () => {
    const { service, auth, prisma } = setup({ status: 'GOOGLE_AUTHENTICATED', verifiedEmail: 'owner@example.com', googleSubject: 'subject' }); auth.validateCredentials.mockRejectedValue(new Error('Invalid credentials'));
    await expect(service.link('browser', 'wrong-password', {})).rejects.toThrow('Invalid credentials'); expect(prisma.oAuthAccount.create).not.toHaveBeenCalled();
  });
  it('bounds linking attempts across repeated requests', async () => {
    const { service, prisma, auth } = setup({ status: 'GOOGLE_AUTHENTICATED', verifiedEmail: 'owner@example.com', googleSubject: 'subject' }); prisma.signupIntent.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.link('browser', 'password', {})).rejects.toThrow('Too many'); expect(auth.validateCredentials).not.toHaveBeenCalled();
  });
  it.each([
    ['cross-workspace membership', { id: 'u1', isActive: true, shop: { companyId: 'other', isActive: true, company: { isActive: true } }, role: { name: 'OWNER' } }],
    ['disabled account', { id: 'u1', isActive: false }],
    ['non-administrator', { id: 'u1', isActive: true, shop: { companyId: 'c1', isActive: true, company: { isActive: true, subscriptionPlan: 'TRIAL' } }, role: { name: 'CASHIER' } }],
  ])('rejects %s before checkout', async (_label, user) => {
    const { service, prisma } = setup({ userId: 'u1', companyId: 'c1', securityVerifiedAt: new Date() }); prisma.user.findUnique.mockResolvedValue(user); await expect(service.assertMember('browser')).rejects.toThrow();
  });
  it('requires MFA for privileged owners before checkout', async () => {
    const { service, prisma } = setup({ userId: 'u1', companyId: 'c1' }); prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, role: { name: 'OWNER' }, shop: { companyId: 'c1', isActive: true, company: { isActive: true } } });
    await expect(service.assertMember('browser')).rejects.toThrow('security');
  });
  it('does not issue full sessions before payment', async () => {
    const { service, prisma, auth } = setup({ userId: 'u1', companyId: 'c1', securityVerifiedAt: new Date(), status: 'PAYMENT_PENDING' }); prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, role: { name: 'OWNER' }, shop: { companyId: 'c1', isActive: true, company: { isActive: true, subscriptionPlan: 'TRIAL' } } });
    await expect(service.finish('browser', {})).rejects.toThrow('Payment'); expect(auth.issueSessionForUser).not.toHaveBeenCalled();
  });
  it('requires terms acceptance before creating a workspace', async () => {
    const { service, prisma } = setup({ userId: 'u1', status: 'WORKSPACE_SETUP_PENDING' }); await expect(service.workspace('browser', { workspaceName: 'Store', agreedToTerms: false }, {})).rejects.toThrow('terms'); expect(prisma.company.create).not.toHaveBeenCalled();
  });
});
