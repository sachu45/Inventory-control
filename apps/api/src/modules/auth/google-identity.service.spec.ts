import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { generateKeyPairSync, sign } from 'crypto';
import { GoogleIdentityService, hashOAuthValue } from './google-identity.service';

describe('Google identity verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nonce = 'test-browser-nonce';
  const settings = { GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-only-secret', GOOGLE_REDIRECT_URI: 'http://127.0.0.1:5200/api/v1/auth/onboarding/google/callback', APP_BASE_URL: 'http://127.0.0.1:5200' };
  const service = new GoogleIdentityService(new ConfigService(settings));
  const payload = () => ({ sub: 'google-subject', email: 'owner@example.com', email_verified: true, name: 'Owner', nonce, aud: settings.GOOGLE_CLIENT_ID, iss: 'https://accounts.google.com', iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 3600 });
  function token(overrides = {}, badSignature = false) {
    const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const input = encode({ alg: 'RS256', kid: 'test-key' }) + '.' + encode({ ...payload(), ...overrides });
    return input + '.' + (badSignature ? Buffer.from('invalid').toString('base64url') : sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url'));
  }
  let codeExchange: jest.SpyInstance;
  beforeEach(() => {
    codeExchange = jest.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens: { id_token: token() }, res: null } as any);
    jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({ certs: { 'test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() }, format: 'PEM' } as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it('validates a real signed ID token using Google’s verifier and exchanges the code with PKCE', async () => {
    await expect(service.exchange('code', 'verifier', hashOAuthValue(nonce))).resolves.toMatchObject({ subject: 'google-subject', email: 'owner@example.com' });
    expect(codeExchange).toHaveBeenCalledWith({ code: 'code', codeVerifier: 'verifier', redirect_uri: settings.GOOGLE_REDIRECT_URI });
  });
  it.each([
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['wrong audience', { aud: 'attacker-client' }],
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['wrong nonce', { nonce: 'different-transaction' }],
    ['missing nonce', { nonce: undefined }],
    ['unverified email', { email_verified: false }],
    ['missing subject', { sub: undefined }],
  ])('rejects %s', async (_label, overrides) => {
    codeExchange.mockResolvedValue({ tokens: { id_token: token(overrides) } });
    await expect(service.exchange('code', 'verifier', hashOAuthValue(nonce))).rejects.toThrow('could not be verified');
  });
  it('rejects an invalid signature', async () => {
    codeExchange.mockResolvedValue({ tokens: { id_token: token({}, true) } });
    await expect(service.exchange('code', 'verifier', hashOAuthValue(nonce))).rejects.toThrow('could not be verified');
  });
  it('requests only identity scopes, account selection, state, nonce and S256', () => {
    const url = new URL(service.authorizationUrl('state', nonce, 'verifier'));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', 'profile']);
    expect(url.searchParams.get('state')).toBe('state');
    expect(url.searchParams.get('nonce')).toBe(nonce);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe('verifier');
    expect(url.href).not.toContain(settings.GOOGLE_CLIENT_SECRET);
  });
  it('fails safely without credentials or an exact callback route', () => {
    expect(() => new GoogleIdentityService(new ConfigService({})).settings()).toThrow('not configured');
    expect(() => new GoogleIdentityService(new ConfigService({ ...settings, GOOGLE_REDIRECT_URI: 'https://app.example/wrong' })).settings()).toThrow('callback');
  });
});
