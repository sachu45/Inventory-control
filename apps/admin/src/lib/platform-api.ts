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
    const res = await api.get(tenantPath(companyId));
    return unwrap<TenantDetail>(res.data);
  },
};

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  not?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
};

export type ModuleSettings = Record<string, unknown>;

export type DraftRow = {
  id: string;
  enabled: boolean | null;
  config: ModuleSettings;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
};

export type DraftModule = {
  key: string;
  label: string;
  sidebarSection: string;
  defaultEnabled: boolean;
  alwaysEnabled: boolean;
  planGate: string | null;
  requiredPermission: string | null;
  dependsOn: string[];
  defaults: ModuleSettings;
  customizableFields: string[];
  supportsCustomFields: boolean;
  lockedMandatoryFields: string[];
  shopOverridable: string[];
  configSchema: JsonSchema;
  draft: DraftRow | null;
  shops: (DraftRow & { shopId: string })[];
};

export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect';
export type CustomFieldOption = { value: string; label: string; archived?: boolean };
export type CustomFieldDefinition = {
  id: string;
  moduleKey: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: CustomFieldOption[] | null;
  validation: { min?: number; max?: number; maxLength?: number; pattern?: string } | null;
  required: boolean;
  defaultValue: unknown;
  searchable: boolean;
  readRoles: string[];
  writeRoles: string[];
  sortOrder: number;
  archivedAt: string | null;
};

export type ConfigIssue = { path: string; message: string };
export type ConfigChange = { path: string; before: unknown; after: unknown };
export type Preview = { baseVersion: number; issues: ConfigIssue[]; changes: ConfigChange[] };
export type PublishResult = { version: { id: string; version: number }; changes: ConfigChange[] };
export type VersionSummary = {
  id: string;
  version: number;
  sourceVersion: number | null;
  changeNote: string | null;
  publishedBy: string;
  publishedAt: string;
};

export type ConfigLayer = 'registry' | 'company' | 'shop';
export type EffectiveConfig = {
  config: {
    version: number;
    shopId: string | null;
    modules: Record<string, { enabled: boolean; config: ModuleSettings }>;
    provenance: Record<string, ConfigLayer>;
  };
  user?: { id: string; email: string; role: string; usableModules: string[] };
};

const tenantPath = (companyId: string) => `/platform/tenants/${encodeURIComponent(companyId)}`;
const draftPath = (companyId: string, key: string, shopId?: string | null) =>
  `${tenantPath(companyId)}/draft/${shopId ? `shops/${encodeURIComponent(shopId)}/` : ''}modules/${encodeURIComponent(key)}`;

export const configApi = {
  async listDrafts(companyId: string): Promise<DraftModule[]> {
    const res = await api.get(`${tenantPath(companyId)}/draft/modules`);
    return unwrap<{ modules: DraftModule[] }>(res.data).modules;
  },
  /** Creates the scope's draft row, or updates it when `revision` matches; 409 when stale. */
  async setDraft(
    companyId: string,
    key: string,
    body: { enabled: boolean | null; config: ModuleSettings; revision?: number },
    shopId?: string | null,
  ): Promise<DraftRow> {
    const res = await api.put(draftPath(companyId, key, shopId), body);
    return unwrap<DraftRow>(res.data);
  },
  async resetDraft(companyId: string, key: string, revision: number, shopId?: string | null): Promise<void> {
    await api.delete(draftPath(companyId, key, shopId), { params: { revision } });
  },
  async preview(companyId: string): Promise<Preview> {
    const res = await api.post(`${tenantPath(companyId)}/draft/preview`);
    return unwrap<Preview>(res.data);
  },
  async publish(companyId: string, expectedBaseVersion: number, note?: string): Promise<PublishResult> {
    const res = await api.post(`${tenantPath(companyId)}/publish`, { expectedBaseVersion, note: note || undefined });
    return unwrap<PublishResult>(res.data);
  },
  async listVersions(companyId: string): Promise<VersionSummary[]> {
    const res = await api.get(`${tenantPath(companyId)}/versions`);
    return unwrap<VersionSummary[]>(res.data);
  },
  async diff(companyId: string, from: number, to: number): Promise<ConfigChange[]> {
    const res = await api.get(`${tenantPath(companyId)}/versions/${from}/diff/${to}`);
    return unwrap<{ changes: ConfigChange[] }>(res.data).changes;
  },
  async rollback(companyId: string, version: number, expectedBaseVersion: number, note?: string): Promise<PublishResult> {
    const res = await api.post(`${tenantPath(companyId)}/versions/${version}/rollback`, {
      expectedBaseVersion,
      note: note || undefined,
    });
    return unwrap<PublishResult>(res.data);
  },
  async effective(companyId: string, params: { shopId?: string; userId?: string }): Promise<EffectiveConfig> {
    const res = await api.get(`${tenantPath(companyId)}/effective`, {
      params: { shopId: params.shopId || undefined, userId: params.userId || undefined },
    });
    return unwrap<EffectiveConfig>(res.data);
  },
};

const customFieldsPath = (companyId: string) => `${tenantPath(companyId)}/draft/custom-fields`;

export const customFieldApi = {
  async list(companyId: string): Promise<CustomFieldDefinition[]> {
    const res = await api.get(customFieldsPath(companyId));
    return unwrap<CustomFieldDefinition[]>(res.data);
  },
  async create(companyId: string, body: Record<string, unknown>): Promise<CustomFieldDefinition> {
    const res = await api.post(customFieldsPath(companyId), body);
    return unwrap<CustomFieldDefinition>(res.data);
  },
  async update(companyId: string, id: string, body: Record<string, unknown>): Promise<CustomFieldDefinition> {
    const res = await api.patch(`${customFieldsPath(companyId)}/${encodeURIComponent(id)}`, body);
    return unwrap<CustomFieldDefinition>(res.data);
  },
  /** Fields are archived, never deleted: values stay stored and the field can be restored. */
  async setArchived(companyId: string, id: string, archived: boolean): Promise<CustomFieldDefinition> {
    const res = await api.post(`${customFieldsPath(companyId)}/${encodeURIComponent(id)}/${archived ? 'archive' : 'restore'}`);
    return unwrap<CustomFieldDefinition>(res.data);
  },
};
