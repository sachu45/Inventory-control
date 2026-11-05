import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { configToSave, dependencyStatus, isDirty, isEnabled, savedState } from './lib/config-editing';
import { configApi, platformApi, type DraftModule, type TenantDetail } from './lib/platform-api';
import { useSession } from './lib/session';

const fieldsEnum = { type: 'array', items: { type: 'string', enum: ['remarks', 'lineCategory'] } };
const schema = {
  type: 'object',
  properties: { mandatoryFields: fieldsEnum, hiddenFields: fieldsEnum, label: { type: 'string', maxLength: 40 } },
  required: ['mandatoryFields', 'hiddenFields'],
};

function moduleOf(key: string, overrides: Partial<DraftModule> = {}): DraftModule {
  return {
    key,
    label: key === 'products' ? 'Products' : 'Purchase Orders',
    sidebarSection: 'procurement',
    defaultEnabled: true,
    alwaysEnabled: false,
    planGate: null,
    requiredPermission: null,
    dependsOn: [],
    defaults: { mandatoryFields: [], hiddenFields: [] },
    customizableFields: ['remarks', 'lineCategory'],
    supportsCustomFields: false,
    lockedMandatoryFields: ['supplier'],
    shopOverridable: [],
    configSchema: schema,
    draft: null,
    shops: [],
    ...overrides,
  };
}

const products = moduleOf('products', { sidebarSection: 'master-data' });
const po = moduleOf('purchase-orders', {
  dependsOn: ['products'],
  draft: { id: 'd1', enabled: null, config: { mandatoryFields: ['remarks'] }, revision: 3, updatedAt: '', updatedBy: null },
});
const tenant: TenantDetail = {
  id: 'c1',
  companyCode: 'ACME',
  companyName: 'Acme Retail',
  isActive: true,
  subscriptionPlan: 'PLUS',
  subscriptionStatus: 'ACTIVE',
  shops: [{ id: 's1', shopNumber: 'HQ-001', shopName: 'Head Office', isActive: true }],
  activeConfig: null,
  draftCount: 1,
};

function axiosError(status: number, error: { code: string; message: string; details?: unknown }) {
  const err = new AxiosError('failed', String(status));
  err.response = { status, data: { success: false, error }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } };
  return err;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('config editing helpers', () => {
  it('merges defaults with the saved draft and tracks dirtiness', () => {
    expect(savedState(po)).toEqual({ enabled: null, config: { mandatoryFields: ['remarks'], hiddenFields: [] } });
    expect(isDirty(po, undefined)).toBe(false);
    expect(isDirty(po, savedState(po))).toBe(false);
    expect(isDirty(po, { enabled: false, config: savedState(po).config })).toBe(true);
  });

  it('saves only settings that differ from the registry defaults', () => {
    expect(configToSave(po, { mandatoryFields: ['remarks'], hiddenFields: [], label: undefined })).toEqual({
      mandatoryFields: ['remarks'],
    });
  });

  it('works out enabled state and dependency status from unsaved edits', () => {
    expect(isEnabled(po, savedState(po))).toBe(true);
    expect(isEnabled(moduleOf('settings', { alwaysEnabled: true }), { enabled: false, config: {} })).toBe(true);
    expect(dependencyStatus(po, [products, po], {})).toEqual([{ key: 'products', label: 'Products', ok: true }]);
    expect(dependencyStatus(po, [products, po], { products: { enabled: false, config: {} } })[0].ok).toBe(false);
  });
});

describe('config editor pages', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSession.getState().setSession('tok', { id: 'u1', name: 'Admin', email: 'a@example.com', isPlatformAdmin: true });
    vi.spyOn(platformApi, 'getTenant').mockResolvedValue(tenant);
    vi.spyOn(configApi, 'listDrafts').mockResolvedValue([products, po]);
  });

  it('renders a settings form from the schema, marks edits unsaved, and saves only the change', async () => {
    const setDraft = vi.spyOn(configApi, 'setDraft').mockResolvedValue({ ...po.draft!, revision: 4 });
    const user = userEvent.setup();
    renderAt('/tenants/c1/modules');

    expect(await screen.findByText('Requires: Products ✓')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Purchase Orders/ }));
    const hidden = screen.getAllByRole('checkbox', { name: 'Line Category' })[1];
    await user.click(hidden);

    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 unsaved change');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(setDraft).toHaveBeenCalledWith('c1', 'purchase-orders', {
        enabled: null,
        config: { mandatoryFields: ['remarks'], hiddenFields: ['lineCategory'] },
        revision: 3,
      }),
    );
    expect(await screen.findByText('Draft saved. Publish to make it live.')).toBeInTheDocument();
  });

  it('keeps the edit and explains a 409 when someone else changed the draft', async () => {
    vi.spyOn(configApi, 'setDraft').mockRejectedValue(
      axiosError(409, { code: 'CONFIG_DRAFT_REVISION_CONFLICT', message: 'stale' }),
    );
    const user = userEvent.setup();
    renderAt('/tenants/c1/modules');

    await user.selectOptions(await screen.findByLabelText('Purchase Orders enabled'), 'false');
    await user.click(screen.getByRole('button', { name: /Purchase Orders/ }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this draft');
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('warns when a module is on but a module it requires is off', async () => {
    const user = userEvent.setup();
    renderAt('/tenants/c1/modules');
    await user.selectOptions(await screen.findByLabelText('Products enabled'), 'false');
    expect(screen.getByText('Requires: Products ✗')).toBeInTheDocument();
    expect(screen.getByText(/Publishing will be rejected/)).toBeInTheDocument();
  });

  it('blocks publishing while preview reports problems, listing every one', async () => {
    vi.spyOn(configApi, 'preview').mockResolvedValue({
      baseVersion: 0,
      issues: [
        { path: 'modules.rfqs.enabled', message: 'Quote Requests requires Products to be enabled' },
        { path: 'modules.purchase-orders.enabled', message: 'Purchase Orders requires Products to be enabled' },
      ],
      changes: [{ path: 'company.products.enabled', before: true, after: false }],
    });
    const user = userEvent.setup();
    renderAt('/tenants/c1/publish');
    await user.click(await screen.findByRole('button', { name: 'Preview drafts' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Publish as/ })).not.toBeInTheDocument();
  });

  it('publishes on the previewed base version and explains a 409', async () => {
    vi.spyOn(configApi, 'preview').mockResolvedValue({
      baseVersion: 2,
      issues: [],
      changes: [{ path: 'company.contracts.enabled', before: true, after: false }],
    });
    const publish = vi
      .spyOn(configApi, 'publish')
      .mockRejectedValueOnce(axiosError(409, { code: 'CONFIG_VERSION_CONFLICT', message: 'stale' }))
      .mockResolvedValueOnce({ version: { id: 'v', version: 3 }, changes: [] });
    const user = userEvent.setup();
    renderAt('/tenants/c1/publish');
    await user.click(await screen.findByRole('button', { name: 'Preview drafts' }));
    expect(await screen.findByText('company.contracts.enabled')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Change note'), 'Turn off contracts');
    await user.click(screen.getByRole('button', { name: 'Publish as v3' }));
    expect(await screen.findByText(/Someone published since this preview/)).toBeInTheDocument();
    expect(publish).toHaveBeenCalledWith('c1', 2, 'Turn off contracts');

    await user.click(screen.getByRole('button', { name: 'Publish as v3' }));
    expect(await screen.findByText(/Published version 3/)).toBeInTheDocument();
  });
});
