import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { BillingModule } from '../billing/billing.module';
import { SubscriptionLifecycleModule } from '../subscription-lifecycle/subscription-lifecycle.module';
import { CacheModule } from '@/common/cache/cache.module';
import { LoginLockoutService } from '@/common/guards/login-rate-limit.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { WhatsAppAdapter } from '../agent-platform/channels/whatsapp/whatsapp.adapter';
import { InviteService } from './invite.service';
import { MfaService } from './mfa.service';
import { PasswordResetService } from './password-reset.service';
import { SignupService } from './signup.service';
import { GoogleIdentityService } from './google-identity.service';
import { GoogleOnboardingService } from './google-onboarding.service';
import { GoogleOnboardingController } from './google-onboarding.controller';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [PassportModule, BillingModule, SubscriptionLifecycleModule, CacheModule],
  controllers: [AuthController, GoogleOnboardingController],
  providers: [AuthService, SignupService, InviteService, MfaService, PasswordResetService, JwtStrategy, LoginLockoutService, WhatsAppAdapter, GoogleIdentityService, GoogleOnboardingService],
  exports: [AuthService, SignupService, InviteService, MfaService, PasswordResetService],
})
export class AuthModule {}
