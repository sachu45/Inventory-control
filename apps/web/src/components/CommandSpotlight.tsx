import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Package, Users, Truck, ArrowRight, AlertCircle } from '@/components/ui/icons';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { buildNavCommands, filterNavCommands } from '@/lib/app-navigation';
import { useAuthStore } from '@/store/authStore';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { api } from '@/api/client';
import { isOrgAdminUser } from '@/lib/roles';

type SearchRecord = { id: string; label: string; code: string; kind: string; path: string; icon: typeof Package };
function rows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const body = payload as { data?: unknown; items?: unknown };
  if (Array.isArray(body.items)) return body.items;
  return body.data ? rows(body.data) : [];
}

export function CommandSpotlight({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="erp-search-dialog sm:max-w-2xl">
    <SearchContent open={open} close={() => onOpenChange(false)} />
  </DialogContent></Dialog>;
}

function SearchContent({ open, close }: { open: boolean; close: () => void }) {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query.trim(), 300);
  const user = useAuthStore(state => state.user);
  const navigate = useNavigate();
  const container = useRef<HTMLDivElement>(null);
  const can = (permission: string) => isOrgAdminUser(user) || user?.permissions.includes(permission);
  const sources = [
    { path: '/products', permission: 'product:read', name: 'Product', label: 'description', code: 'productCode', icon: Package },
    { path: '/customers', permission: 'shop:read', name: 'Customer', label: 'customerName', code: 'customerCode', icon: Users },
    { path: '/suppliers', permission: 'supplier:read', name: 'Supplier', label: 'supplierName', code: 'supplierCode', icon: Truck },
  ].filter(source => can(source.permission));
  const recordQuery = useQuery({
    queryKey: ['global-search', user?.companyId, user?.id, user?.permissions.join(','), debounced],
    enabled: open && !!user && debounced.length >= 2,
    retry: false,
    staleTime: 15000,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled(sources.map(async source => {
        const response = await api.get(source.path, { signal, params: { search: debounced, ...(source.path === '/products' ? { page: 1, limit: 6 } : { take: 6 }) } });
        return rows(response.data).slice(0, 6).map(row => {
          const id = String(row.id ?? '');
          const label = String(row[source.label] ?? row.name ?? row[source.code] ?? 'Untitled record');
          const code = String(row[source.code] ?? '');
          return { id, label, code, kind: source.name, path: source.path + '?' + new URLSearchParams({ search: code || label, record: id }), icon: source.icon } satisfies SearchRecord;
        }).filter(row => row.id);
      }));
      return { records: results.flatMap(result => result.status === 'fulfilled' ? result.value : []), failed: results.filter(result => result.status === 'rejected').length };
    },
  });
  const commands = filterNavCommands(buildNavCommands(user), query).slice(0, query.trim() ? 7 : 5);
  const records = debounced.length >= 2 ? recordQuery.data?.records ?? [] : [];
  function go(path: string) { close(); navigate(path); }
  function keyboard(event: React.KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[data-search-result]') ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0);
    buttons[next]?.focus();
  }
  return <div ref={container} onKeyDown={keyboard}>
    <DialogTitle className="sr-only">Search your workspace</DialogTitle>
    <DialogDescription className="sr-only">Search products, customers, suppliers, pages and actions. Use arrow keys to move between results.</DialogDescription>
    <div className="erp-search-input"><Search size={21} /><input autoFocus aria-label="Search records and pages" placeholder="Search products, contacts, pages…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>esc</kbd></div>
    <div className="erp-search-results">
      {debounced.length >= 2 && <section aria-label="Record results"><h3>Records {recordQuery.isFetching && <span role="status">· Searching…</span>}</h3>
        {recordQuery.data?.failed ? <p className="erp-search-message"><AlertCircle size={15} />Some records could not be searched. Try again in a moment.</p> : null}
        {records.map(record => <button type="button" data-search-result key={record.kind + record.id} onClick={() => go(record.path)}><record.icon size={18} /><span><strong>{record.label}</strong><small>{record.kind}{record.code ? ' · ' + record.code : ''}</small></span><ArrowRight size={15} /></button>)}
        {!recordQuery.isFetching && !recordQuery.isError && !recordQuery.data?.failed && records.length === 0 && <p className="erp-search-message">No matching records in the modules you can access.</p>}
      </section>}
      <section aria-label="Page results"><h3>{query.trim() ? 'Pages & actions' : 'Quick access'}</h3>
        {commands.map(command => <button type="button" data-search-result key={command.id} onClick={() => go(command.path)}><command.icon size={18} /><span><strong>{command.label}</strong><small>{command.hint}</small></span><ArrowRight size={15} /></button>)}
        {!commands.length && <p className="erp-search-message">No matching pages. Try “products”, “sales” or “settings”.</p>}
      </section>
    </div>
    <footer className="erp-search-footer"><span>↑ ↓ to navigate · Enter to open</span><span>{debounced.length < 2 ? 'Type 2 characters to search records' : 'Results respect your access permissions'}</span></footer>
  </div>;
}
