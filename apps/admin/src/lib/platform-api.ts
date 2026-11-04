import { api, unwrap } from './api';
import type { AdminUser } from './session';

export type SubscriptionPlan = 'TRIAL' | 'PRO' | 'PLUS';
export type SubscriptionStatus = string;

export type TenantSummary = {
  id: string;
  companyCode: string;
  companyName: string;
  isActive: boolean;
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus;
  createdAt: string;
  activeConfig: { version: number; publishedAt: string } | null;
};

export type TenantPage = {
  items: TenantSummary[];
  meta: { nextCursor: string | null; limit: number; hasMore: boolean };
};

export type TenantDetail = Omit<TenantSummary, 'createdAt' | 'activeConfig'> & {
  shops: { id: string; shopNumber: string; shopName: string; isActive: boolean }[];
  activeConfig: { version: number; publishedAt: string; publishedBy: string } | null;
  draftCount: number;
};

export type LoginResult =
  | { kind: 'session'; accessToken: string; user: AdminUser }
  | { kind: 'mfa'; challengeToken: string }
  | { kind: 'mfa-setup' };

type LoginBody = {
  accessToken?: string;
  user?: AdminUser;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  challengeToken?: string;
};

function toLoginResult(body: LoginBody): LoginResult {
  if (body.accessToken && body.user) return { kind: 'session', accessToken: body.accessToken, user: body.user };
  if (body.mfaRequired && body.challengeToken) return { kind: 'mfa', challengeToken: body.challengeToken };
  if (body.mfaSetupRequired) return { kind: 'mfa-setup' };
  throw new Error('Unexpected sign-in response');
}

export const authApi = {
  async login(email: string, password: string): Promise<LoginResult> {
    const res = await api.post('/auth/login', { email, password });
    return toLoginResult(unwrap<LoginBody>(res.data));
  },
  async verifyMfa(challengeToken: string, code: string): Promise<LoginResult> {
    const res = await api.post('/auth/mfa/login/verify', { challengeToken, code });
    return toLoginResult(unwrap<LoginBody>(res.data));
  },
};

export const platformApi = {
  async listTenants(params: { search?: string; cursor?: string; take?: number }): Promise<TenantPage> {
    const res = await api.get('/platform/tenants', {
      params: { search: params.search || undefined, cursor: params.cursor, take: params.take ?? 25 },
    });
    return unwrap<TenantPage>(res.data);
  },
  async getTenant(companyId: string): Promise<TenantDetail> {
    const res = await api.get(`/platform/tenants/${encodeURIComponent(companyId)}`);
    return unwrap<TenantDetail>(res.data);
  },
};
