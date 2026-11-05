import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { CsrfGuard } from '../../common/guards/csrf.guard';
import { GoogleOnboardingController } from './google-onboarding.controller';

describe('Onboarding endpoint security', () => {
  it.each(['start', 'link', 'workspace', 'securityStart', 'securityVerify', 'checkout', 'verifyPayment', 'finish', 'cancel'])('requires CSRF for %s', method => {
    const handler = (GoogleOnboardingController.prototype as any)[method];
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(CsrfGuard);
  });
  it('reports missing Google configuration without creating identities or exposing secrets', () => {
    const controller = new GoogleOnboardingController({} as any, { settings: () => { throw new Error('private details'); } } as any, {} as any, new ConfigService({}), {} as any);
    const res = { setHeader: jest.fn(), cookie: jest.fn() };
    const response = controller.configuration(res as any);
    expect(response.available).toBe(false);
    expect(JSON.stringify(response)).not.toContain('private details');
    expect(res.cookie).toHaveBeenCalledWith('csrf_token', expect.any(String), expect.objectContaining({ sameSite: 'lax', path: '/' }));
  });
});
