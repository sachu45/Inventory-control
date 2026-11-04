import { useMemo } from 'react';
import { useMeConfig } from '@/hooks/use-me-config';
import { moduleKeyForPath } from '@/lib/module-routes';

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

export type ModuleFieldConfig = {
  /** Field the organisation hid: leave it out of forms, tables and exports. */
  isHidden: (field: string) => boolean;
  /** Field the organisation made mandatory (and did not also hide). */
  isRequired: (field: string) => boolean;
  /** Mandatory fields that are blank in `values`; the API rejects these with 422. */
  missing: (values: Record<string, unknown>) => string[];
};

/**
 * One module's hidden and mandatory fields from the published config. With no
 * config loaded every field is visible and optional, i.e. exactly today's forms.
 */
export function useModuleFields(moduleKey: string): ModuleFieldConfig {
  const meConfig = useMeConfig();
  const config = meConfig?.modules[moduleKey]?.config;
  return useMemo(() => {
    const hidden = new Set(config?.hiddenFields ?? []);
    const mandatory = new Set((config?.mandatoryFields ?? []).filter((f) => !hidden.has(f)));
    return {
      isHidden: (field) => hidden.has(field),
      isRequired: (field) => mandatory.has(field),
      missing: (values) => [...mandatory].filter((field) => isBlank(values[field])),
    };
  }, [config]);
}

/** Whether a module (by key or by one of its page paths) is usable; true when no config is loaded. */
export function useModuleUsable(): (keyOrPath: string) => boolean {
  const meConfig = useMeConfig();
  return useMemo(
    () => (keyOrPath: string) => {
      if (!meConfig) return true;
      const key = keyOrPath.startsWith('/') ? moduleKeyForPath(keyOrPath.split('?')[0]) : keyOrPath;
      return key ? (meConfig.modules[key]?.usable ?? true) : true;
    },
    [meConfig],
  );
}

/** Core pages whose headers belong to many sub-sections; never relabelled. */
const UNLABELLED = new Set(['settings', 'upgrade']);

/**
 * The organisation's own name for a module, when it set one, for the module whose
 * list page is `path` (e.g. "/plants" -> "Branches"). Undefined keeps today's text.
 */
export function useCustomModuleLabel(): (path: string) => string | undefined {
  const meConfig = useMeConfig();
  return useMemo(
    () => (path: string) => {
      const key = moduleKeyForPath(path);
      if (!key || UNLABELLED.has(key) || path.replace(/\/+$/, '').split('/').length !== 2) return undefined;
      return meConfig?.modules[key]?.config.label;
    },
    [meConfig],
  );
}
