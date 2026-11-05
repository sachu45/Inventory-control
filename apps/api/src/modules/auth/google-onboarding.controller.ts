import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { Public } from '../../common/decorators/public.decorator';
import { CSRF_COOKIE_NAME, CsrfGuard } from '../../common/guards/csrf.guard';
import { OnboardingBillingService } from '../billing/onboarding-billing.service';
import { VerifyPaymentDto } from '../billing/dto/billing.dto';
import { GoogleIdentityService, hashOAuthValue } from './google-identity.service';
import { GoogleOnboardingService } from './google-onboarding.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OnboardingLinkDto, OnboardingMfaDto, OnboardingWorkspaceDto, SignupIntentDto } from './dto/google-onboarding.dto';

const COOKIE = 'google_onboarding';
const PATH = '/api/v1/auth/onboarding';

@Public()
@Throttle({ auth: { ttl: 60_000, limit: 10 } })
@Controller('auth/onboarding')
export class GoogleOnboardingController {
  constructor(private readonly onboarding: GoogleOnboardingService, private readonly google: GoogleIdentityService,
    private readonly billing: OnboardingBillingService, private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private cookieOptions() { return { httpOnly: true, secure: this.config.get('NODE_ENV') === 'production', sameSite: 'lax' as const, path: PATH, maxAge: 60 * 60_000 }; }
  private session(req: Request): string | undefined { return req.cookies?.[COOKIE]; }
  private ctx(req: Request) { return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null }; }

  @Get('configuration')
  configuration(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    // A same-site double-submit token protects start as well as subsequent mutations.
    res.cookie(CSRF_COOKIE_NAME, randomUUID(), { secure: this.cookieOptions().secure, sameSite: 'lax', path: '/', maxAge: 60 * 60_000 });
    try { this.google.settings(); return { available: true }; } catch { return { available: false, message: 'Google signup needs administrator configuration. Your existing password sign-in is still available.' }; }
  }

  @Post('intent') @UseGuards(CsrfGuard)
  async start(@Body() dto: SignupIntentDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.onboarding.start(dto);
    res.cookie(COOKIE, result.session, this.cookieOptions());
    res.setHeader('Cache-Control', 'no-store');
    return { authorizationUrl: result.authorizationUrl };
  }

  @Get('google/callback')
  async callback(@Req() req: Request, @Query('state') state: string, @Query('code') code: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const destination = this.google.settings().appUrl + '/signup/google/continue';
    try {
      const session = this.session(req);
      await this.onboarding.callback(session, state, code, error);
      const intent = await this.onboarding.intent(session);
      const rotated = randomBytes(32).toString('base64url');
      await this.prisma.signupIntent.update({ where: { id: intent.id }, data: { sessionHash: hashOAuthValue(rotated) } });
      res.cookie(COOKIE, rotated, this.cookieOptions());
      return res.redirect(destination);
    } catch {
      return res.redirect(destination + '?error=' + (error === 'access_denied' ? 'cancelled' : 'invalid-callback'));
    }
  }

  @Get('session')
  async snapshot(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.onboarding.snapshot(this.session(req));
  }

  @Post('link') @UseGuards(CsrfGuard)
  async link(@Req() req: Request, @Body() dto: OnboardingLinkDto) {
    await this.onboarding.link(this.session(req), dto.password, this.ctx(req)); return { ok: true };
  }

  @Post('workspace') @UseGuards(CsrfGuard)
  async workspace(@Req() req: Request, @Body() dto: OnboardingWorkspaceDto) {
    await this.onboarding.workspace(this.session(req), dto, this.ctx(req)); return { ok: true };
  }

  @Post('security/start') @UseGuards(CsrfGuard)
  securityStart(@Req() req: Request) { return this.onboarding.securityStart(this.session(req), this.ctx(req)); }

  @Post('security/verify') @UseGuards(CsrfGuard)
  securityVerify(@Req() req: Request, @Body() dto: OnboardingMfaDto) { return this.onboarding.securityVerify(this.session(req), dto.token, dto.code, dto.backupCode, this.ctx(req)); }

  @Post('checkout') @UseGuards(CsrfGuard)
  async checkout(@Req() req: Request) {
    const intent = await this.onboarding.assertMember(this.session(req));
    return this.billing.checkout(intent.id);
  }

  @Post('payment/verify') @UseGuards(CsrfGuard)
  async verifyPayment(@Req() req: Request, @Body() dto: VerifyPaymentDto) {
    const intent = await this.onboarding.assertMember(this.session(req));
    return this.billing.verify(intent.id, dto.razorpay_order_id, dto.razorpay_payment_id, dto.razorpay_signature);
  }

  @Post('finish') @UseGuards(CsrfGuard)
  async finish(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.onboarding.finish(this.session(req), this.ctx(req));
    const configured = this.config.get<string>('AUTH_COOKIE_SAME_SITE')?.toLowerCase();
    const sameSite = configured === 'none' || configured === 'strict' || configured === 'lax' ? configured : this.cookieOptions().secure ? 'none' : 'lax';
    const options = { secure: sameSite === 'none' || this.cookieOptions().secure, sameSite, maxAge: 7 * 24 * 60 * 60_000 } as const;
    res.cookie(this.config.get('REFRESH_COOKIE_NAME', 'session_id'), result.refreshCookieValue, { ...options, httpOnly: true, path: '/api/v1/auth', signed: Boolean(this.config.get<string>('COOKIE_SECRET')?.trim()) });
    res.cookie(CSRF_COOKIE_NAME, randomUUID(), { ...options, path: '/' });
    res.clearCookie(COOKIE, { ...this.cookieOptions(), maxAge: undefined });
    res.setHeader('Cache-Control', 'no-store');
    return { accessToken: result.accessToken, user: result.user };
  }

  @Post('cancel') @UseGuards(CsrfGuard)
  async cancel(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const intent = await this.onboarding.intent(this.session(req));
    // Cancelling this browser flow never cancels an already paid subscription.
    await this.prisma.signupIntent.update({ where: { id: intent.id }, data: { ...(intent.status === 'SUBSCRIPTION_ACTIVE' ? {} : { status: 'CANCELLED' }), sessionHash: hashOAuthValue(randomBytes(32).toString('base64url')), pkceVerifier: null } });
    res.clearCookie(COOKIE, { ...this.cookieOptions(), maxAge: undefined });
    return { ok: true };
  }
}
