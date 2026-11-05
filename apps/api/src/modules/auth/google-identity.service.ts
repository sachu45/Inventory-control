import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { createHash, timingSafeEqual } from 'crypto';

export const hashOAuthValue = (value: string) => createHash('sha256').update(value).digest('hex');
export function matchesOAuthHash(value: string, expected: string) {
  const actual = Buffer.from(hashOAuthValue(value));
  const stored = Buffer.from(expected);
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

@Injectable()
export class GoogleIdentityService {
  constructor(private readonly config: ConfigService) {}

  settings() {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET')?.trim();
    const redirectUri = this.config.get<string>('GOOGLE_REDIRECT_URI')?.trim();
    const appUrl = this.config.get<string>('APP_BASE_URL')?.trim();
    if (!clientId || !clientSecret || !redirectUri || !appUrl) {
      throw new ServiceUnavailableException('Google signup is not configured. Contact the workspace administrator.');
    }
    for (const value of [redirectUri, appUrl]) {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
        throw new ServiceUnavailableException('Invalid Google signup URL configuration.');
      }
    }
    if (new URL(redirectUri).pathname !== '/api/v1/auth/onboarding/google/callback') {
      throw new ServiceUnavailableException('Google redirect URI must point to the onboarding callback.');
    }
    return { clientId, clientSecret, redirectUri, appUrl: appUrl.replace(/\/$/, '') };
  }

  private client() {
    const cfg = this.settings();
    return new OAuth2Client(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  }

  authorizationUrl(state: string, nonce: string, verifier: string) {
    return this.client().generateAuthUrl({
      access_type: 'online', scope: ['openid', 'email', 'profile'],
      prompt: 'select_account', state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  async exchange(code: string, verifier: string, nonceHash: string) {
    try {
      const client = this.client();
      const { tokens } = await client.getToken({ code, codeVerifier: verifier, redirect_uri: this.settings().redirectUri });
      if (!tokens.id_token) throw new Error('Missing ID token');
      // Google's library validates the signature, issuer, audience and expiry.
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.settings().clientId });
      const claims = ticket.getPayload();
      const nonce = (claims as typeof claims & { nonce?: string })?.nonce;
      if (!claims?.sub || !claims.email || claims.email_verified !== true || !nonce || !matchesOAuthHash(nonce, nonceHash)) {
        throw new Error('Invalid verified identity');
      }
      return { subject: claims.sub, email: claims.email.trim().toLowerCase(), name: claims.name?.slice(0, 150) || 'Workspace owner', picture: claims.picture?.startsWith('https://') ? claims.picture : null };
    } catch {
      // Never include provider responses, authorization codes or tokens in logs/errors.
      throw new BadRequestException('Google identity could not be verified. Start again.');
    }
  }
}
