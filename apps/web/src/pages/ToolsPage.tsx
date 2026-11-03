import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { PageHeader } from '@/components/shared/page-header';
import { Input } from '@/components/ui/input';
import { ArrowRight, Search } from '@/components/ui/icons';
import { useAuthStore } from '@/store/authStore';
import { visibleTools, TOOL_GROUPS, TOOL_COPY } from '@/lib/simple-navigation';

export function ToolsPage() {
  const [params] = useSearchParams();
  return <ToolsContent key={params.get('section') ?? 'all'} />;
}

function ToolsContent() {
  const user = useAuthStore(s => s.user);
  const [params] = useSearchParams();
  const [query, setQuery] = useState('');
  const section = TOOL_GROUPS.find(group => group.id === params.get('section'));
  const tools = visibleTools(user);
  const search = query.trim().toLowerCase();
  const groups = (section ? [section] : TOOL_GROUPS).map(group => ({ ...group, items: group.paths.flatMap(path => {
    const item = tools.find(tool => tool.path === path);
    const copy = TOOL_COPY[path];
    return item && (!search || `${copy?.join(' ')} ${item.label}`.toLowerCase().includes(search)) ? [item] : [];
  }) })).filter(group => group.items.length);

  return <AppLayout active={section?.label ?? 'More tools'}>
    <div className="simple-tools-page">
      <PageHeader title={section?.label ?? 'What would you like to do?'} description={section?.description ?? 'Choose a task below. Each tool tells you what it does.'} showBreadcrumbs={false} />
      <label className="tool-search"><Search size={18} /><span className="sr-only">Find a tool</span><Input placeholder="Find a task, like payments or labels…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      {section && <Link className="text-sm text-primary underline underline-offset-4" to="/tools">See all tools</Link>}
      <div className="tool-directory">{groups.map(group => <section key={group.id} aria-label={group.label}>
        {!section && <div className="tool-group-heading"><h2>{group.label}</h2><p>{group.description}</p></div>}
        <div className="tool-list">{group.items.map(item => <Link key={item.path} to={item.path} className="tool-link">
          <span className="tool-icon"><item.icon size={20} /></span><span><strong>{TOOL_COPY[item.path]?.[0] ?? item.label}</strong><small>{TOOL_COPY[item.path]?.[1] ?? 'Open this tool'}</small></span><ArrowRight size={17} />
        </Link>)}</div>
      </section>)}</div>
      {!groups.length && <div className="context-panel"><h2>No matching tools</h2><p>Try a different word or clear your search.</p><button className="mt-3 text-sm text-primary underline" onClick={() => setQuery('')}>Clear search</button></div>}
    </div>
  </AppLayout>;
}
