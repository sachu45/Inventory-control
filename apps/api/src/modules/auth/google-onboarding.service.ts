import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RoleName, SignupIntentStatus, SubscriptionStatus } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { isDowngrade, orderAmountPaise, toBillingCycle, toSubscriptionPlan } from '../../common/plans/plan-config';
import { AuthService, type LoginContext } from './auth.service';
import { MfaService } from './mfa.service';
import { GoogleIdentityService, hashOAuthValue, matchesOAuthHash } from './google-identity.service';
import { OnboardingWorkspaceDto, SignupIntentDto } from './dto/google-onboarding.dto';

const randomToken = () => randomBytes(32).toString('base64url');
const terminal = new Set<SignupIntentStatus>(['CANCELLED', 'EXPIRED', 'FAILED']);

@Injectable()
export class GoogleOnboardingService {
  private readonly logger = new Logger(GoogleOnboardingService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService,
    private readonly google: GoogleIdentityService, private readonly auth: AuthService, private readonly mfa: MfaService) {}

  async start(dto: SignupIntentDto) {
    this.google.settings(); // Missing credentials must fail before creating an intent.
    if (['false', '0'].includes(this.config.get<string>('SIGNUP_ENABLED') ?? '') && !dto.loginOnly) throw new ForbiddenException('New signups are disabled.');
    if (!dto.loginOnly && !['pro', 'plus'].includes(dto.plan ?? '')) throw new BadRequestException('Choose Pro or Plus.');
    if (dto.billing && !['monthly', 'yearly'].includes(dto.billing)) throw new BadRequestException('Invalid billing interval.');
    const plan = dto.plan ?? 'pro';
    const billing = dto.billing ?? 'monthly';
    const session = randomToken(), state = randomToken(), nonce = randomToken(), verifier = randomToken();
    const now = Date.now();
    await this.prisma.signupIntent.create({ data: {
      loginOnly: dto.loginOnly === true, plan: toSubscriptionPlan(plan), billingCycle: toBillingCycle(billing),
      amountPaise: dto.loginOnly ? 0 : orderAmountPaise(plan, billing), pricingVersion: 'catalog-2026-01-tax-zero',
      sessionHash: hashOAuthValue(session), stateHash: hashOAuthValue(state), nonceHash: hashOAuthValue(nonce), pkceVerifier: verifier,
      oauthExpiresAt: new Date(now + 10 * 60_000), expiresAt: new Date(now + 60 * 60_000),
    } });
    return { session, authorizationUrl: this.google.authorizationUrl(state, nonce, verifier) };
  }

  async intent(session: string | undefined) {
    if (!session) throw new UnauthorizedException('Your onboarding session has ended. Choose a plan to start again.');
    const intent = await this.prisma.signupIntent.findUnique({ where: { sessionHash: hashOAuthValue(session) } });
    if (!intent) throw new UnauthorizedException('Invalid onboarding session.');
    if (intent.expiresAt.getTime() <= Date.now()) {
      await this.prisma.signupIntent.update({ where: { id: intent.id }, data: { status: 'EXPIRED', pkceVerifier: null } });
      throw new UnauthorizedException('Signup intent expired. Choose a plan to start again.');
    }
    if (terminal.has(intent.status)) throw new BadRequestException('Onboarding was cancelled or failed. Start again.');
    return intent;
  }

  async callback(session: string | undefined, state: string, code?: string, providerError?: string) {
    const intent = await this.intent(session);
    if (!state || !matchesOAuthHash(state, intent.stateHash) || intent.oauthExpiresAt.getTime() <= Date.now()) {
      this.logger.warn(JSON.stringify({ event: 'GOOGLE_CALLBACK_REJECTED', reason: 'STATE_OR_EXPIRY', intentId: intent.id }));
      throw new BadRequestException('Invalid or expired Google transaction.');
    }
    // Claim before exchange: a code/state pair can only be processed once, even concurrently.
    const claim = await this.prisma.signupIntent.updateMany({ where: { id: intent.id, status: 'OAUTH_PENDING' }, data: { status: providerError ? 'CANCELLED' : 'GOOGLE_AUTHENTICATED', pkceVerifier: null } });
    if (claim.count !== 1) {
      this.logger.warn(JSON.stringify({ event: 'GOOGLE_CALLBACK_REJECTED', reason: 'REPLAY', intentId: intent.id }));
      throw new ConflictException('Google callback was already processed.');
    }
    if (providerError) throw new BadRequestException('Google authentication was cancelled.');
    try {
      if (!code || !intent.pkceVerifier) throw new BadRequestException('Missing authorization code.');
      const identity = await this.google.exchange(code, intent.pkceVerifier, intent.nonceHash);
      await this.prisma.signupIntent.update({ where: { id: intent.id }, data: { googleSubject: identity.subject, verifiedEmail: identity.email, profileName: identity.name, profilePicture: identity.picture } });
      const account = await this.prisma.oAuthAccount.findUnique({ where: { provider_providerSubject: { provider: 'google', providerSubject: identity.subject } }, include: { user: true } });
      let userId = account?.userId;
      if (account && (!account.user.isActive || account.user.deletedAt || (account.user.lockedUntil && account.user.lockedUntil > new Date()))) throw new UnauthorizedException('Account is unavailable or temporarily locked.');
      if (!account) {
        const existing = await this.prisma.user.findUnique({ where: { email: identity.email } });
        // A matching email is not authorization to link accounts. Ask for existing credentials.
        if (existing) return;
        if (intent.loginOnly) throw new BadRequestException('No linked Google account. Choose a plan to create a workspace.');
        const role = await this.prisma.role.findFirst({ where: { name: RoleName.OWNER } });
        if (!role) throw new ServiceUnavailableException('System roles are not initialized.');
        const passwordHash = await bcrypt.hash(randomToken(), 12); // No usable local password for Google-only identities.
        userId = await this.prisma.$transaction(async tx => {
          const user = await tx.user.create({ data: { name: identity.name, email: identity.email, avatarUrl: identity.picture, passwordHash, roleId: role.id, onboardingRequired: true } });
          await tx.oAuthAccount.create({ data: { provider: 'google', providerSubject: identity.subject, verifiedEmail: identity.email, userId: user.id } });
          return user.id;
        });
      }
      await this.attachUser(intent.id, userId!);
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'GOOGLE_CALLBACK_REJECTED', reason: 'IDENTITY_OR_ACCOUNT', intentId: intent.id }));
      await this.prisma.signupIntent.update({ where: { id: intent.id }, data: { status: 'FAILED' } });
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Account already created in another tab. Start again to sign in.');
      throw error;
    }
  }

  private async attachUser(intentId: string, userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true, shop: true } });
    if (!user.isActive || user.deletedAt || (user.lockedUntil && user.lockedUntil > new Date())) throw new UnauthorizedException('Account unavailable.');
    const intent = await this.prisma.signupIntent.findUniqueOrThrow({ where: { id: intentId } });
    // Only workspace owners/admins may bind a paid signup to an existing tenant.
    if (!intent.loginOnly && user.shopId && !([RoleName.OWNER, RoleName.ADMIN] as RoleName[]).includes(user.role.name)) throw new ForbiddenException('Ask your workspace administrator to manage its subscription.');
    if (user.shopId && !user.shop?.companyId) throw new ForbiddenException('Workspace membership is invalid.');
    await this.prisma.signupIntent.update({ where: { id: intentId }, data: { userId, companyId: user.shop?.companyId, status: user.shopId ? 'CHECKOUT_PENDING' : 'WORKSPACE_SETUP_PENDING' } });
  }

  async link(session: string | undefined, password: string, ctx: LoginContext) {
    const intent = await this.intent(session);
    if (intent.status !== 'GOOGLE_AUTHENTICATED' || intent.userId || !intent.verifiedEmail || !intent.googleSubject) throw new BadRequestException('Account linking is unavailable.');
    const reserved = await this.prisma.signupIntent.updateMany({ where: { id: intent.id, linkAttempts: { lt: 5 } }, data: { linkAttempts: { increment: 1 } } });
    if (!reserved.count) throw new ForbiddenException('Too many attempts. Start again or use account recovery.');
    const user = await this.auth.validateCredentials({ email: intent.verifiedEmail, password }, ctx);
    // Serialize linking and recheck the intent so concurrent attempts cannot replace an identity.
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.signupIntent.updateMany({ where: { id: intent.id, userId: null, status: 'GOOGLE_AUTHENTICATED' }, data: { userId: user.id, status: 'ACCOUNT_CREATED' } });
      if (!claimed.count) throw new ConflictException('Account linking already processed.');
      await tx.oAuthAccount.create({ data: { provider: 'google', providerSubject: intent.googleSubject!, verifiedEmail: intent.verifiedEmail!, userId: user.id } });
    });
    await this.attachUser(intent.id, user.id);
  }

  async snapshot(session: string | undefined) {
    const intent = await this.intent(session);
    const user = intent.userId ? await this.prisma.user.findUnique({ where: { id: intent.userId }, include: { role: true, shop: true } }) : null;
    if (intent.userId && (!user?.isActive || user.deletedAt)) throw new UnauthorizedException('Account unavailable.');
    if (intent.loginOnly && user?.onboardingRequired) throw new BadRequestException('This account has unfinished signup. Choose a plan to resume workspace setup and payment.');
    return { status: intent.status, loginOnly: intent.loginOnly, plan: intent.plan.toLowerCase(), billing: intent.billingCycle.toLowerCase(), amountPaise: intent.amountPaise, taxPaise: 0, currency: 'INR', expiresAt: intent.expiresAt,
      user: intent.verifiedEmail ? { name: user?.name ?? intent.profileName, email: intent.verifiedEmail, picture: intent.profilePicture } : null,
      linkRequired: intent.status === 'GOOGLE_AUTHENTICATED' && !intent.userId,
      securityRequired: !!user && !intent.securityVerifiedAt && (user.mfaEnabled || ([RoleName.OWNER, RoleName.ADMIN] as RoleName[]).includes(user.role.name)),
      mfaEnabled: user?.mfaEnabled ?? false, workspaceReady: !!intent.companyId };
  }

  async workspace(session: string | undefined, dto: OnboardingWorkspaceDto, ctx: LoginContext) {
    const intent = await this.intent(session);
    if (!intent.userId || intent.loginOnly || dto.agreedToTerms !== true || !dto.workspaceName.trim()) throw new BadRequestException('Workspace name and accepted terms are required.');
    if (intent.companyId) return;
    if (intent.status !== 'WORKSPACE_SETUP_PENDING') throw new BadRequestException('Workspace setup is not available.');
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.signupIntent.updateMany({ where: { id: intent.id, status: 'WORKSPACE_SETUP_PENDING', companyId: null }, data: { status: 'CHECKOUT_PENDING' } });
      if (!claimed.count) throw new ConflictException('Workspace setup already processed.');
      const user = await tx.user.findUniqueOrThrow({ where: { id: intent.userId! } });
      if (user.shopId) throw new ConflictException('Account already belongs to a workspace. Restart signup.');
      const company = await tx.company.create({ data: { companyCode: `WS-${randomUUID()}`, companyName: dto.companyName?.trim() || dto.workspaceName.trim(), subscriptionPlan: 'TRIAL', subscriptionStatus: 'SUSPENDED', trialEndsAt: new Date(0) } });
      const shop = await tx.shop.create({ data: { companyId: company.id, shopNumber: `HQ-${randomUUID()}`, shopName: dto.workspaceName.trim(), address: '', contactPerson: user.name, mobile: '', email: user.email } });
      await tx.user.update({ where: { id: user.id }, data: { shopId: shop.id } });
      await tx.userConsent.create({ data: { userId: user.id, acceptedAt: new Date(), termsVersion: this.config.get('TERMS_VERSION', '1.0'), privacyPolicyVersion: this.config.get('PRIVACY_POLICY_VERSION', '1.0'), ipAddress: ctx.ip?.slice(0, 45), userAgent: ctx.userAgent?.slice(0, 512) } });
      await tx.signupIntent.update({ where: { id: intent.id }, data: { companyId: company.id } });
    });
  }

  async securityStart(session: string | undefined, ctx: LoginContext) {
    const intent = await this.intent(session);
    if (!intent.userId || !intent.companyId || intent.securityVerifiedAt) throw new BadRequestException('Security verification is unavailable.');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: intent.userId } });
    return user.mfaEnabled ? this.mfa.createLoginChallenge(user.id, user.email, ctx) : this.mfa.startAccountEnrollment(user.id, ctx);
  }

  async securityVerify(session: string | undefined, token: string, code: string | undefined, backupCode: string | undefined, ctx: LoginContext) {
    const intent = await this.intent(session);
    if (!intent.userId || !intent.companyId || intent.securityVerifiedAt) throw new BadRequestException('Security verification is unavailable.');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: intent.userId } });
    let backupCodes: string[] | undefined;
    if (user.mfaEnabled) {
      // Bind the supplied challenge to this identity before using the existing MFA verifier.
      const challenge = await this.prisma.authChallenge.findFirst({ where: { tokenHash: hashOAuthValue(token), userId: user.id, consumedAt: null } });
      if (!challenge) throw new UnauthorizedException('MFA challenge does not belong to this account.');
      await this.mfa.verifyOnboardingLogin({ challengeToken: token, code, backupCode }, user.id);
    } else {
      if (!code) throw new BadRequestException('Enter your authenticator code.');
      const result = await this.mfa.verifyAccountEnrollment(user.id, { token, code }, ctx);
      backupCodes = result.backupCodes;
    }
    await this.prisma.signupIntent.update({ where: { id: intent.id }, data: { securityVerifiedAt: new Date() } });
    return { backupCodes };
  }

  async assertMember(session: string | undefined) {
    const intent = await this.intent(session);
    if (!intent.userId || !intent.companyId) throw new ForbiddenException('Complete workspace setup first.');
    const user = await this.prisma.user.findUnique({ where: { id: intent.userId }, include: { role: true, shop: { include: { company: true } } } });
    if (!user?.isActive || user.deletedAt || user.shop?.companyId !== intent.companyId || !user.shop.isActive || !user.shop.company?.isActive || (user.lockedUntil && user.lockedUntil > new Date())) throw new ForbiddenException('Workspace membership is invalid.');
    if ((user.mfaEnabled || ([RoleName.OWNER, RoleName.ADMIN] as RoleName[]).includes(user.role.name)) && !intent.securityVerifiedAt) throw new ForbiddenException('Complete security verification first.');
    if (!intent.loginOnly && (!([RoleName.OWNER, RoleName.ADMIN] as RoleName[]).includes(user.role.name) || isDowngrade(user.shop.company.subscriptionPlan, intent.plan))) throw new ForbiddenException('This account cannot apply the selected plan to this workspace.');
    return intent;
  }

  async finish(session: string | undefined, ctx: LoginContext) {
    const intent = await this.assertMember(session);
    if (!intent.loginOnly) {
      const payment = intent.orderId ? await this.prisma.subscriptionPayment.findUnique({ where: { razorpayOrderId: intent.orderId } }) : null;
      if (intent.status !== 'SUBSCRIPTION_ACTIVE' || !payment?.verifiedAt || !payment.consumedAt || payment.status !== 'paid' || payment.companyId !== intent.companyId || payment.plan !== intent.plan || payment.amountPaise !== intent.amountPaise) throw new ForbiddenException('Payment has not been confirmed.');
      const company = await this.prisma.company.findUniqueOrThrow({ where: { id: intent.companyId! } });
      if (company.subscriptionStatus !== SubscriptionStatus.ACTIVE || company.subscriptionPlan !== intent.plan || !company.subscriptionEndsAt || company.subscriptionEndsAt <= new Date()) throw new ForbiddenException('Subscription is not active.');
    }
    // Claim before issuing a full session: concurrent/replayed completion cannot issue twice.
    const claimed = await this.prisma.signupIntent.updateMany({ where: { id: intent.id, sessionHash: intent.sessionHash }, data: { sessionHash: hashOAuthValue(randomToken()) } });
    if (!claimed.count) throw new ConflictException('Session completion already processed. Sign in to continue.');
    const result = await this.auth.issueSessionForUser(intent.userId!, ctx);
    return result;
  }
}
