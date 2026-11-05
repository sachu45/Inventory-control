import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiErrorInfo } from '@/lib/api';
import {
  byDisplayOrder,
  createBody,
  emptyForm,
  FIELD_TYPES,
  formFromField,
  movedSortOrders,
  ROLES,
  updateBody,
  usesOptions,
  type FieldForm,
} from '@/lib/custom-field-editing';
import { configApi, customFieldApi, type ConfigIssue, type CustomFieldDefinition, type CustomFieldType } from '@/lib/platform-api';

const inputClass = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100 disabled:text-slate-500';
const buttonClass = 'rounded-md border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50 disabled:opacity-40';

type Feedback = { tone: 'error' | 'ok'; text: string; issues?: ConfigIssue[] };

function feedbackFrom(error: unknown): Feedback {
  const info = apiErrorInfo(error);
  return { tone: 'error', text: info.message, issues: Array.isArray(info.details) ? (info.details as ConfigIssue[]) : undefined };
}

function RoleChoices({ legend, hint, value, onChange }: { legend: string; hint: string; value: string[]; onChange: (roles: string[]) => void }) {
  return (
    <fieldset className="rounded-md border border-slate-200 p-2">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <p className="mb-1 text-xs text-slate-500">{hint}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {ROLES.map((role) => (
          <label key={role} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.includes(role)}
              onChange={(e) => onChange(e.target.checked ? [...value, role] : value.filter((r) => r !== role))}
            />
            {role}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function FieldEditor({
  form,
  saved,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  form: FieldForm;
  saved: CustomFieldDefinition | null;
  busy: boolean;
  onChange: (patch: Partial<FieldForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const savedOptions = new Set((saved?.options ?? []).map((o) => o.value));
  const setOption = (index: number, patch: Partial<FieldForm['options'][number]>) =>
    onChange({ options: form.options.map((o, i) => (i === index ? { ...o, ...patch } : o)) });

  return (
    <form
      aria-label={saved ? `Edit ${saved.label}` : 'New custom field'}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h2 className="font-semibold">{saved ? `Edit ${saved.label}` : 'New custom field'}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Label</span>
          <input className={inputClass} value={form.label} required maxLength={200} onChange={(e) => onChange({ label: e.target.value })} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Key</span>
          <input
            className={inputClass}
            value={form.fieldKey}
            required
            disabled={Boolean(saved)}
            aria-describedby="field-key-hint"
            onChange={(e) => onChange({ fieldKey: e.target.value })}
          />
          <span id="field-key-hint" className="text-xs text-slate-500">
            {saved ? 'A key cannot change. Create a new field instead.' : 'Lowercase letters, digits and _. It cannot change later.'}
          </span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Type</span>
          <select
            className={inputClass}
            value={form.fieldType}
            aria-describedby={saved ? 'field-type-hint' : undefined}
            onChange={(e) => onChange({ fieldType: e.target.value as CustomFieldType })}
          >
            {FIELD_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
          {saved && (
            <span id="field-type-hint" className="text-xs text-slate-500">
              Locked once any record holds a value; saving will say so.
            </span>
          )}
        </label>
        <label className="block text-sm">
          <span className="font-medium">Default value</span>
          {form.fieldType === 'boolean' ? (
            <select className={inputClass} value={form.defaultValue} onChange={(e) => onChange({ defaultValue: e.target.value })}>
              <option value="">None</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : (
            <input
              className={inputClass}
              type={form.fieldType === 'number' ? 'number' : form.fieldType === 'date' ? 'date' : 'text'}
              step="any"
              value={form.defaultValue}
              onChange={(e) => onChange({ defaultValue: e.target.value })}
            />
          )}
          {form.fieldType === 'multiselect' && <span className="text-xs text-slate-500">Option values, separated by commas.</span>}
        </label>
      </div>

      {usesOptions(form.fieldType) && (
        <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium">Options</legend>
          {form.options.map((option, index) => {
            const isSaved = savedOptions.has(option.value);
            return (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`Option ${index + 1} value`}
                  className={`${inputClass} max-w-40`}
                  placeholder="Value"
                  value={option.value}
                  required
                  disabled={isSaved}
                  onChange={(e) => setOption(index, { value: e.target.value })}
                />
                <input
                  aria-label={`Option ${index + 1} label`}
                  className={`${inputClass} max-w-52`}
                  placeholder="Label"
                  value={option.label}
                  required
                  onChange={(e) => setOption(index, { label: e.target.value })}
                />
                {isSaved ? (
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={Boolean(option.archived)} onChange={(e) => setOption(index, { archived: e.target.checked })} />
                    Archived
                  </label>
                ) : (
                  <button type="button" className={buttonClass} onClick={() => onChange({ options: form.options.filter((_, i) => i !== index) })}>
                    Remove
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" className={buttonClass} onClick={() => onChange({ options: [...form.options, { value: '', label: '' }] })}>
            Add option
          </button>
          {savedOptions.size > 0 && <p className="text-xs text-slate-500">Saved options are archived rather than removed, so existing values stay readable.</p>}
        </fieldset>
      )}

      {form.fieldType === 'number' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Minimum</span>
            <input className={inputClass} type="number" step="any" value={form.min} onChange={(e) => onChange({ min: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Maximum</span>
            <input className={inputClass} type="number" step="any" value={form.max} onChange={(e) => onChange({ max: e.target.value })} />
          </label>
        </div>
      )}
      {form.fieldType === 'text' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Maximum length</span>
            <input className={inputClass} type="number" min={1} value={form.maxLength} onChange={(e) => onChange({ maxLength: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Format (regular expression)</span>
            <input className={inputClass} maxLength={200} value={form.pattern} onChange={(e) => onChange({ pattern: e.target.value })} />
          </label>
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.required} onChange={(e) => onChange({ required: e.target.checked })} />
          Required
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.searchable} onChange={(e) => onChange({ searchable: e.target.checked })} />
          Searchable
        </label>
      </div>
      {saved && form.required && !saved.required && (
        <p role="note" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This applies to new and edited records. Existing records keep working until someone edits one, and then it must be filled in.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <RoleChoices legend="Who can read it" hint="None ticked means everyone who can open the module." value={form.readRoles} onChange={(readRoles) => onChange({ readRoles })} />
        <RoleChoices legend="Who can change it" hint="None ticked means everyone who can edit the module." value={form.writeRoles} onChange={(writeRoles) => onChange({ writeRoles })} />
      </div>

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {saved ? 'Save field' : 'Add field'}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CustomFieldsPage() {
  const { companyId = '' } = useParams();
  const queryClient = useQueryClient();
  const modules = useQuery({ queryKey: ['drafts', companyId], queryFn: () => configApi.listDrafts(companyId) });
  const fields = useQuery({ queryKey: ['custom-fields', companyId], queryFn: () => customFieldApi.list(companyId) });

  const supporting = (modules.data ?? []).filter((m) => m.supportsCustomFields);
  const [chosen, setChosen] = useState('');
  const moduleKey = chosen || supporting[0]?.key || '';
  const [form, setForm] = useState<FieldForm | null>(null);
  const [editing, setEditing] = useState<CustomFieldDefinition | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);

  const inModule = (fields.data ?? []).filter((f) => f.moduleKey === moduleKey).sort(byDisplayOrder);
  const active = inModule.filter((f) => !f.archivedAt);
  const archived = inModule.filter((f) => f.archivedAt);

  const closeEditor = () => {
    setForm(null);
    setEditing(null);
  };

  const run = async (work: () => Promise<string>, after?: () => void) => {
    setBusy(true);
    setFeedback(null);
    try {
      const text = await work();
      await queryClient.invalidateQueries({ queryKey: ['custom-fields', companyId] });
      after?.();
      setFeedback({ tone: 'ok', text });
    } catch (error) {
      setFeedback(feedbackFrom(error));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!form) return;
    void run(async () => {
      if (editing) {
        await customFieldApi.update(companyId, editing.id, updateBody(form, editing));
      } else {
        const last = active.at(-1)?.sortOrder ?? 0;
        await customFieldApi.create(companyId, createBody(form, last + 10));
      }
      return 'Saved as a draft. Publish to make it live.';
    }, closeEditor);
  };

  const move = (field: CustomFieldDefinition, delta: -1 | 1) =>
    void run(async () => {
      for (const change of movedSortOrders(active, field.id, delta)) {
        await customFieldApi.update(companyId, change.id, { sortOrder: change.sortOrder });
      }
      return 'Order saved as a draft. Publish to make it live.';
    });

  const setArchived = (field: CustomFieldDefinition, archive: boolean) =>
    void run(async () => {
      await customFieldApi.setArchived(companyId, field.id, archive);
      return archive
        ? `${field.label} archived. Its values are kept, and it goes away for users once you publish.`
        : `${field.label} restored. Publish to make it live again.`;
    });

  if (modules.isPending || fields.isPending) return <p className="text-slate-500">Loading custom fields…</p>;
  if (modules.isError || fields.isError) {
    return <p role="alert" className="text-red-700">{apiErrorInfo(modules.error ?? fields.error).message}</p>;
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="block text-sm">
          <span className="font-medium">Module</span>
          <select
            className={inputClass}
            value={moduleKey}
            onChange={(e) => {
              setChosen(e.target.value);
              closeEditor();
              setFeedback(null);
            }}
          >
            {supporting.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-slate-600">
          Changes here are <strong>drafts</strong>: users see nothing until you publish.
        </p>
        {!form && (
          <button
            type="button"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
            onClick={() => {
              setEditing(null);
              setFeedback(null);
              setForm(emptyForm(moduleKey));
            }}
          >
            Add field
          </button>
        )}
      </div>

      {feedback && (
        <div role={feedback.tone === 'error' ? 'alert' : 'status'} className={feedback.tone === 'error' ? 'rounded-md bg-red-50 px-3 py-2 text-sm text-red-700' : 'rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800'}>
          {feedback.text}
          {feedback.issues && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {feedback.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {form && (
        <FieldEditor
          form={form}
          saved={editing}
          busy={busy}
          onChange={(patch) => setForm((current) => (current ? { ...current, ...patch } : current))}
          onSave={save}
          onCancel={closeEditor}
        />
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {active.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No custom fields in this module yet.</p>
        ) : (
          <ul aria-label="Custom fields" className="divide-y divide-slate-100">
            {active.map((field, index) => (
              <li key={field.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-48 flex-1">
                  <span className="font-medium">{field.label}</span>
                  <span className="ml-2 text-xs text-slate-500">{field.fieldKey}</span>
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{FIELD_TYPES.find((t) => t.value === field.fieldType)?.label ?? field.fieldType}</span>
                  {field.required && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">Required</span>}
                  {field.searchable && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">Searchable</span>}
                </div>
                <button type="button" className={buttonClass} aria-label={`Move ${field.label} up`} disabled={busy || index === 0} onClick={() => move(field, -1)}>
                  ↑
                </button>
                <button type="button" className={buttonClass} aria-label={`Move ${field.label} down`} disabled={busy || index === active.length - 1} onClick={() => move(field, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  aria-label={`Edit ${field.label}`}
                  onClick={() => {
                    setEditing(field);
                    setFeedback(null);
                    setForm(formFromField(field));
                  }}
                >
                  Edit
                </button>
                <button type="button" className={buttonClass} aria-label={`Archive ${field.label}`} disabled={busy} onClick={() => setArchived(field, true)}>
                  Archive
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {archived.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Archived: hidden from users, values kept
          </h2>
          <ul aria-label="Archived fields" className="divide-y divide-slate-100">
            {archived.map((field) => (
              <li key={field.id} className="flex items-center gap-3 px-4 py-3 text-slate-500">
                <span className="flex-1">
                  {field.label} <span className="text-xs">{field.fieldKey}</span>
                </span>
                <button type="button" className={buttonClass} aria-label={`Restore ${field.label}`} disabled={busy} onClick={() => setArchived(field, false)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
