import type { DraftModule, ModuleSettings } from './platform-api';

/** An unsaved edit of one module's company-wide draft. `enabled: null` = inherit the default. */
export type ModuleEdit = { enabled: boolean | null; config: ModuleSettings };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The draft as stored: registry defaults with the saved draft config merged over them. */
export function savedState(mod: DraftModule): ModuleEdit {
  return { enabled: mod.draft?.enabled ?? null, config: { ...mod.defaults, ...(mod.draft?.config ?? {}) } };
}

export function currentState(mod: DraftModule, edit: ModuleEdit | undefined): ModuleEdit {
  return edit ?? savedState(mod);
}

export function isEnabled(mod: DraftModule, state: ModuleEdit): boolean {
  return mod.alwaysEnabled || (state.enabled ?? mod.defaultEnabled);
}

export function isDirty(mod: DraftModule, edit: ModuleEdit | undefined): boolean {
  return edit !== undefined && !same(edit, savedState(mod));
}

/**
 * What to store: only settings that differ from the registry defaults, so a later
 * change to a default still reaches tenants who never touched that setting.
 */
export function configToSave(mod: DraftModule, config: ModuleSettings): ModuleSettings {
  return Object.fromEntries(
    Object.entries(config).filter(([key, value]) => value !== undefined && !same(value, mod.defaults[key])),
  );
}

/** Whether each dependency is enabled, given the current (possibly unsaved) state of every module. */
export function dependencyStatus(
  mod: DraftModule,
  modules: DraftModule[],
  edits: Record<string, ModuleEdit>,
): { key: string; label: string; ok: boolean }[] {
  return mod.dependsOn.map((dep) => {
    const depMod = modules.find((m) => m.key === dep);
    if (!depMod) return { key: dep, label: dep, ok: false };
    return { key: dep, label: depMod.label, ok: isEnabled(depMod, currentState(depMod, edits[dep])) };
  });
}
