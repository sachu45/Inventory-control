import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PATH_METADATA } from '@nestjs/common/constants';
import { isModuleKey } from './module-registry';
import { REQUIRES_MODULE_KEY } from './requires-module.decorator';

/**
 * Controllers that are deliberately not tied to a tenant module. Anything else
 * must declare @RequiresModule, so a new business controller cannot ship
 * without ModuleEnabledGuard covering it.
 */
const EXEMPT: Record<string, string> = {
  // Identity, billing, platform and personal routes (spec §9.1).
  AuthController: 'sign-in and session',
  UsersController: 'user admin and /users/me',
  DeviceRegistrationController: 'personal devices',
  BillingController: 'subscription billing must stay reachable',
  BillingWebhookController: 'payment provider webhook',
  PlatformSubscriptionsController: 'platform admin',
  PlatformNotificationController: 'platform admin',
  ConfigAdminController: 'platform admin (tenant config)',
  PlatformFeatureFlagsController: 'platform admin (tenant feature flags)',
  PlatformCustomFieldsController: 'platform admin (tenant custom fields)',
  MeConfigController: 'the user\'s own resolved config and preferences',
  // Infrastructure.
  HealthController: 'health checks',
  MetricsController: 'metrics scrape',
  QueueMetricsController: 'queue metrics',
  PdfHealthController: 'PDF renderer health',
  WorkflowEngineController: 'engine shared by every workflow-enabled module',
  DispatchWebhookController: 'workflow webhook ingress',
  PostalCodesController: 'reference data lookup',
  // Cross-module tools: they serve several modules' data at once.
  AuditController: 'audit log across modules',
  BackupController: 'data portability must stay reachable',
  ExportController: 'exports across modules',
  DocumentsController: 'PDF documents across modules',
  AlertsController: 'stock alerts across modules',
  InventoryLotsController: 'lot data used by receipts, issues and reports',
  InventoryHealthController: 'inventory checks across modules',
  DamagedStockController: 'no registry module yet',
  // WhatsApp assistant has its own settings and plan gate.
  WhatsAppWebhookController: 'provider webhook',
  LinkController: 'WhatsApp account link',
  AiSettingsController: 'assistant settings',
  // Public token portals have no tenant user. Their services check the module
  // with ModuleAccessService, using the company the link token belongs to.
  SupplierPortalController: 'public portal; SupplierPortalService checks supplier-portal',
  QuotationPortalController: 'public portal; QuotationPortalService checks sales-quotations',
};

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

function controllers(): { name: string; file: string; module: unknown }[] {
  const src = join(__dirname, '..', '..');
  return controllerFiles(src).flatMap((file) =>
    Object.values(require(file) as Record<string, unknown>)
      .filter((value): value is new (...args: never[]) => unknown => typeof value === 'function')
      .filter((cls) => Reflect.getMetadata(PATH_METADATA, cls) !== undefined)
      .map((cls) => ({
        name: cls.name,
        file: relative(src, file),
        module: Reflect.getMetadata(REQUIRES_MODULE_KEY, cls) as unknown,
      })),
  );
}

describe('@RequiresModule route table', () => {
  const all = controllers();

  it('finds the app controllers', () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it('every business controller declares a valid @RequiresModule', () => {
    const missing = all.filter((c) => c.module === undefined && !(c.name in EXEMPT)).map((c) => c.file);
    expect(missing).toEqual([]);
    const invalid = all.filter((c) => c.module !== undefined && !isModuleKey(String(c.module))).map((c) => c.file);
    expect(invalid).toEqual([]);
  });

  it('exempt controllers do not also declare a module, and every exemption still exists', () => {
    const names = new Set(all.map((c) => c.name));
    expect(Object.keys(EXEMPT).filter((name) => !names.has(name))).toEqual([]);
    expect(all.filter((c) => c.name in EXEMPT && c.module !== undefined).map((c) => c.name)).toEqual([]);
  });
});
