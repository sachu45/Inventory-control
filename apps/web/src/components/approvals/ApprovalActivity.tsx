import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useApprovalComments, useAddApprovalComment, type ApprovalRequest } from '@/hooks/use-approvals';

export function ApprovalActivity({ record }: { record: ApprovalRequest }) {
  const comments = useApprovalComments(record.id);
  const add = useAddApprovalComment();
  const [text, setText] = useState('');
  const events = [
    { id:'requested', date:record.createdAt, title:'Approval requested', body:record.description ?? '' },
    ...(record.approvedAt ? [{ id:'approved', date:record.approvedAt, title:'Approved', body:'' }] : []),
    ...(record.rejectedAt ? [{ id:'rejected', date:record.rejectedAt, title:'Rejected', body:record.rejectionReason ?? '' }] : []),
    ...(comments.data ?? []).map(comment => ({ id:comment.id, date:comment.createdAt, title:'Comment', body:comment.comment })),
  ].sort((a,b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return <section className="erp-activity" aria-label="Approval activity"><h3>Activity</h3>
    {comments.isError && <p role="alert" className="text-xs text-destructive">Comments could not be loaded. <button className="underline" onClick={() => comments.refetch()}>Retry</button></p>}
    <ol>{events.map(event => <li key={event.id}><span /><div><strong>{event.title}</strong><time>{new Date(event.date).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' })}</time>{event.body && <p>{event.body}</p>}</div></li>)}</ol>
    <form onSubmit={async event => { event.preventDefault(); if (!text.trim() || add.isPending) return; try { await add.mutateAsync({ id:record.id, comment:text.trim() }); setText(''); toast.success('Comment added'); } catch { toast.error('Could not add your comment.'); } }}>
      <label htmlFor={`approval-comment-${record.id}`}>Add a comment</label><Textarea id={`approval-comment-${record.id}`} rows={3} value={text} onChange={event => setText(event.target.value)} placeholder="Leave a note about this request…" maxLength={2000} />
      <Button type="submit" size="sm" loading={add.isPending} disabled={!text.trim() || add.isPending}>Post comment</Button>
    </form>
  </section>;
}
