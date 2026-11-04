import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SchemaForm } from '@/components/SchemaForm';
import { apiErrorInfo } from '@/lib/api';
import {
  configToSave,
  currentState,
  dependencyStatus,
  isDirty,
  isEnabled,
  type ModuleEdit,
} from '@/lib/config-editing';
import { configApi, platformApi, type ConfigIssue, type DraftModule } from '@/lib/platform-api';

const SECTIONS: [string, string][] = [
  ['overview', 'Overview'],
  ['master-data', 'Catalog & contacts'],
  ['procurement', 'Purchasing'],
  ['sales-finance', 'Sales & billing'],
  ['operations', 'Inventory & tools'],
];

type Feedback = { tone: 'error' | 'ok'; text: string; issues?: ConfigIssue[] };

function feedbackFrom(error: unknown): Feedback {
  const info = apiErrorInfo(error);
  if (info.status === 409) {
    return {
      tone: 'error',
      text: 'Someone else changed this draft since you loaded it. Your edit is kept; reload to see their version, then save again.',
    };
  }
  return { tone: 'error', text: info.message, issues: Array.isArray(info.details) ? (info.details as ConfigIssue[]) : undefined };
}

const enabledValue = (enabled: boolean | null) => (enabled === null ? '' : String(enabled));
const parseEnabled = (value: string): boolean | null => (value === '' ? null : value === 'true');

export function ModulesPage() {
  const { companyId = '' } = useParams();
  const queryClient = useQueryClient();
  const drafts = useQuery({ queryKey: ['drafts', companyId], queryFn: () => configApi.listDrafts(companyId) });
  const tenant = useQuery({ queryKey: ['tenant', companyId], queryFn: () => platformApi.getTenant(companyId) });
  const [edits, setEdits] = useState<Record<string, ModuleEdit>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const modules = useMemo(() => drafts.data ?? [], [drafts.data]);
  const dirtyKeys = modules.filter((m) => isDirty(m, edits[m.key])).map((m) => m.key);

  useEffect(() => {
    if (dirtyKeys.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyKeys.length]);

  const edit = (mod: DraftModule, patch: Partial<ModuleEdit>) =>
    setEdits((all) => ({ ...all, [mod.key]: { ...currentState(mod, all[mod.key]), ...patch } }));
  const discard = (key: string) =>
    setEdits(({ [key]: _dropped, ...rest }) => rest);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['drafts', companyId] });

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    setFeedback(({ [key]: _cleared, ...rest }) => rest);
    try {
      const text = await work();
      setFeedback((f) => ({ ...f, [key]: { tone: 'ok', text } }));
    } catch (error) {
      setFeedback((f) => ({ ...f, [key]: feedbackFrom(error) }));
    } finally {
      setBusy(null);
    }
  };

  const save = (mod: DraftModule) =>
    run(mod.key, async () => {
      const state = currentState(mod, edits[mod.key]);
      await configApi.setDraft(companyId, mod.key, {
        enabled: state.enabled,
        config: configToSave(mod, state.config),
        revision: mod.draft?.revision,
      });
      discard(mod.key);
      await refresh();
      return 'Draft saved. Publish to make it live.';
    });

  const reset = (mod: DraftModule) =>
    run(mod.key, async () => {
      if (mod.draft) await configApi.resetDraft(companyId, mod.key, mod.draft.revision);
      discard(mod.key);
      await refresh();
      return 'Reset to the registry default.';
    });

  if (drafts.isPending) return <p className="text-slate-500">Loading modules…</p>;
  if (drafts.isError) return <p role="alert" className="text-red-700">{apiErrorInfo(drafts.error).message}</p>;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Changes here are <strong>drafts</strong>: tenants see nothing until you publish.
        </p>
        {dirtyKeys.length > 0 && (
          <span role="status" className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
            {dirtyKeys.length} unsaved {dirtyKeys.length === 1 ? 'change' : 'changes'}
          </span>
        )}
      </div>

      {SECTIONS.map(([sectionId, title]) => {
        const inSection = modules.filter((m) => m.sidebarSection === sectionId);
        if (inSection.length === 0) return null;
        return (
          <div key={sectionId} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {title}
            </h2>
            <ul className="divide-y divide-slate-100">
              {inSection.map((mod) => {
                const state = currentState(mod, edits[mod.key]);
                const dirty = isDirty(mod, edits[mod.key]);
                const enabled = isEnabled(mod, state);
                const deps = dependencyStatus(mod, modules, edits);
                const brokenDeps = enabled && deps.some((d) => !d.ok);
                const open = expanded === mod.key;
                const note = feedback[mod.key];
                const label = (state.config.label as string | undefined) ?? mod.label;
                return (
                  <li key={mod.key} className={clsx(dirty && 'bg-amber-50/40')}>
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : mod.key)}
                        aria-expanded={open}
                        className="min-w-48 flex-1 text-left"
                      >
                        <span className="font-medium">{label}</span>
                        <span className="ml-2 text-xs text-slate-500">{mod.key}</span>
                        {mod.draft && !dirty && <span className="ml-2 text-xs text-slate-500">· draft rev {mod.draft.revision}</span>}
                        {dirty && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Unsaved</span>}
                      </button>
                      {deps.length > 0 && (
                        <span className={clsx('text-xs', brokenDeps ? 'text-red-700' : 'text-slate-500')}>
                          Requires: {deps.map((d) => `${d.label} ${d.ok ? '✓' : '✗'}`).join(', ')}
                        </span>
                      )}
                      {mod.planGate && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">Plan: {mod.planGate}</span>}
                      {mod.alwaysEnabled ? (
                        <span className="text-xs text-slate-500">Always on</span>
                      ) : (
                        <select
                          aria-label={`${mod.label} enabled`}
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                          value={enabledValue(state.enabled)}
                          onChange={(e) => edit(mod, { enabled: parseEnabled(e.target.value) })}
                        >
                          <option value="">Default ({mod.defaultEnabled ? 'on' : 'off'})</option>
                          <option value="true">On</option>
                          <option value="false">Off</option>
                        </select>
                      )}
                    </div>
                    {brokenDeps && (
                      <p className="px-4 pb-2 text-xs text-red-700">
                        Publishing will be rejected while a required module is off.
                      </p>
                    )}

                    {open && (
                      <div className="space-y-5 border-t border-slate-100 bg-slate-50/60 px-4 py-4">
                        <SchemaForm
                          idPrefix={mod.key}
                          schema={mod.configSchema}
                          value={state.config}
                          locked={mod.lockedMandatoryFields}
                          onChange={(config) => edit(mod, { config })}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={!dirty || busy === mod.key}
                            onClick={() => save(mod)}
                            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                          >
                            Save draft
                          </button>
                          <button
                            type="button"
                            disabled={!dirty}
                            onClick={() => discard(mod.key)}
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
                          >
                            Discard
                          </button>
                          <button
                            type="button"
                            disabled={(!mod.draft && !dirty) || busy === mod.key}
                            onClick={() => reset(mod)}
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
                          >
                            Reset to default
                          </button>
                          {note && <FeedbackLine feedback={note} onReload={refresh} />}
                        </div>
                        <ShopOverrides companyId={companyId} mod={mod} shops={tenant.data?.shops ?? []} onSaved={refresh} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function FeedbackLine({ feedback, onReload }: { feedback: Feedback; onReload: () => void }) {
  return (
    <div role={feedback.tone === 'error' ? 'alert' : 'status'} className={clsx('text-sm', feedback.tone === 'error' ? 'text-red-700' : 'text-emerald-700')}>
      {feedback.text}
      {feedback.text.includes('reload') && (
        <button type="button" onClick={onReload} className="ml-2 underline">
          Reload
        </button>
      )}
      {feedback.issues && feedback.issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {feedback.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code>{issue.path}</code>: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShopOverrides({
  companyId,
  mod,
  shops,
  onSaved,
}: {
  companyId: string;
  mod: DraftModule;
  shops: { id: string; shopName: string; shopNumber: string }[];
  onSaved: () => Promise<unknown>;
}) {
  const [edits, setEdits] = useState<Record<string, ModuleEdit>>({});
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  if (shops.length === 0) return null;

  const rowFor = (shopId: string) => mod.shops.find((s) => s.shopId === shopId);
  const stateFor = (shopId: string): ModuleEdit => {
    const row = rowFor(shopId);
    return edits[shopId] ?? { enabled: row?.enabled ?? null, config: row?.config ?? {} };
  };
  const act = async (shopId: string, work: () => Promise<string>) => {
    try {
      const text = await work();
      setEdits(({ [shopId]: _dropped, ...rest }) => rest);
      await onSaved();
      setFeedback((f) => ({ ...f, [shopId]: { tone: 'ok', text } }));
    } catch (error) {
      setFeedback((f) => ({ ...f, [shopId]: feedbackFrom(error) }));
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shop overrides</h3>
      <ul className="space-y-2">
        {shops.map((shop) => {
          const row = rowFor(shop.id);
          const state = stateFor(shop.id);
          const dirty = edits[shop.id] !== undefined;
          return (
            <li key={shop.id} className="rounded-md border border-slate-200 bg-white px-3 py-2">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="flex-1">
                  {shop.shopName} <span className="text-slate-500">· {shop.shopNumber}</span>
                  {dirty && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Unsaved</span>}
                </span>
                {!mod.alwaysEnabled && (
                  <select
                    aria-label={`${mod.label} at ${shop.shopName}`}
                    className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                    value={enabledValue(state.enabled)}
                    onChange={(e) => setEdits((all) => ({ ...all, [shop.id]: { ...state, enabled: parseEnabled(e.target.value) } }))}
                  >
                    <option value="">Same as company</option>
                    <option value="true">On here</option>
                    <option value="false">Off here</option>
                  </select>
                )}
                <button
                  type="button"
                  disabled={!dirty}
                  onClick={() =>
                    act(shop.id, async () => {
                      await configApi.setDraft(companyId, mod.key, { ...state, revision: row?.revision }, shop.id);
                      return 'Shop override saved.';
                    })
                  }
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  Save
                </button>
                {row && (
                  <button
                    type="button"
                    onClick={() =>
                      act(shop.id, async () => {
                        await configApi.resetDraft(companyId, mod.key, row.revision, shop.id);
                        return 'Shop override removed.';
                      })
                    }
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs"
                  >
                    Remove override
                  </button>
                )}
              </div>
              {mod.shopOverridable.length > 0 && (
                <div className="mt-2">
                  <SchemaForm
                    idPrefix={`${mod.key}-${shop.id}`}
                    schema={mod.configSchema}
                    only={mod.shopOverridable}
                    value={state.config}
                    onChange={(config) => setEdits((all) => ({ ...all, [shop.id]: { ...state, config } }))}
                  />
                </div>
              )}
              {feedback[shop.id] && <FeedbackLine feedback={feedback[shop.id]} onReload={onSaved} />}
            </li>
          );
        })}
      </ul>
      {mod.shopOverridable.length === 0 && (
        <p className="text-xs text-slate-500">Shops can only switch this module on or off; none of its settings are per-shop.</p>
      )}
    </div>
  );
}

