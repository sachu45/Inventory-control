import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { DiffTable } from '@/components/DiffTable';
import { apiErrorInfo } from '@/lib/api';
import { configApi, type Preview } from '@/lib/platform-api';

export function PublishPage() {
  const { companyId = '' } = useParams();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState('');
  const [published, setPublished] = useState<number | null>(null);

  const previewMutation = useMutation({
    mutationFn: () => configApi.preview(companyId),
    onSuccess: (result) => {
      setPreview(result);
      setPublished(null);
    },
  });
  const publishMutation = useMutation({
    mutationFn: (base: number) => configApi.publish(companyId, base, note.trim()),
    onSuccess: (result) => {
      setPublished(result.version.version);
      setPreview(null);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['versions', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['tenant', companyId] });
    },
  });

  const publishError = publishMutation.error ? apiErrorInfo(publishMutation.error) : null;
  const canPublish = preview && preview.issues.length === 0 && preview.changes.length > 0;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => previewMutation.mutate()}
          disabled={previewMutation.isPending}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {preview ? 'Preview again' : 'Preview drafts'}
        </button>
        <p className="text-sm text-slate-600">Compiles the saved drafts and compares them with the live version. Nothing is published.</p>
      </div>

      {previewMutation.isError && <p role="alert" className="text-sm text-red-700">{apiErrorInfo(previewMutation.error).message}</p>}

      {published !== null && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Published version {published}. Tenants pick it up within 5 seconds.
        </p>
      )}

      {preview && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Live version: <strong>{preview.baseVersion === 0 ? 'registry defaults' : `v${preview.baseVersion}`}</strong>
          </p>

          {preview.issues.length > 0 && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="font-medium text-red-800">
                {preview.issues.length} {preview.issues.length === 1 ? 'problem' : 'problems'} must be fixed before publishing
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700">
                {preview.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2 className="font-medium">Changes from the live version</h2>
          <DiffTable changes={preview.changes} empty="The drafts match the live version; there is nothing to publish." />

          {canPublish && (
            <form
              className="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
              onSubmit={(e) => {
                e.preventDefault();
                publishMutation.mutate(preview.baseVersion);
              }}
            >
              <label htmlFor="change-note" className="block text-sm font-medium">
                Change note
              </label>
              <input
                id="change-note"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What changed and why (shown in version history)"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={publishMutation.isPending}
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Publish as v{preview.baseVersion + 1}
              </button>
            </form>
          )}
        </div>
      )}

      {publishError && (
        <p role="alert" className="text-sm text-red-700">
          {publishError.status === 409
            ? 'Someone published since this preview. Preview again to see the current live version, then publish.'
            : publishError.message}
        </p>
      )}
    </section>
  );
}
