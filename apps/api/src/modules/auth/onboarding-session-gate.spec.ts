import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

describe('Pending Google account session gate', () => {
  const pending = { id: 'u1', isActive: true, onboardingRequired: true };
  it('rejects session issuance from password login or recovery before payment', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(pending) } };
    const jwt = { signAsync: jest.fn() };
    const service = new AuthService(prisma as any, jwt as any, new ConfigService({}), {} as any, {} as any);
    await expect(service.issueSessionForUser('u1')).rejects.toThrow('Complete Google onboarding');
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
  it('rejects bearer access to all existing tenant resources for an unfinished account', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(pending) }, shop: { findMany: jest.fn() } };
    const strategy = new JwtStrategy(prisma as any, new ConfigService({ JWT_SECRET: 'test-only-secret' }));
    await expect(strategy.validate({ sub: 'u1' })).rejects.toThrow();
    expect(prisma.shop.findMany).not.toHaveBeenCalled();
  });
});
