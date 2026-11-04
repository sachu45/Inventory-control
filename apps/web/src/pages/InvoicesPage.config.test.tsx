import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { MeConfig } from '@/api/me-config';
import { useAuthStore } from '@/store/authStore';
import { InvoicesPage } from './InvoicesPage';

// jsdom has no matchMedia; the breadcrumb bar uses it to pick a compact layout.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

const mutateAsync = vi.fn();
vi.mock('@/components/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-invoices', () => ({
  useInvoices: () => ({ data: [] }),
  useCreateInvoice: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('@/hooks/use-customers', () => ({ useCustomers: () => ({ data: [{ id: 'cu1', customerName: 'Acme', shopId: 's1' }] }) }));
vi.mock('@/hooks/use-sales-orders', () => ({ useSalesOrders: () => ({ data: [] }), useSalesOrder: () => ({ data: undefined }) }));
vi.mock('@/components/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // A plain select keeps the test independent of the combobox implementation.
  DocumentReferenceSelect: ({ items, value, onValueChange, placeholder }: { items: { id: string; customerName?: string }[]; value: string; onValueChange: (v: string) => void; placeholder: string }) => (
    <select aria-label={placeholder} value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">—</option>
      {items.map((i) => <option key={i.id} value={i.id}>{i.customerName ?? i.id}</option>)}
    </select>
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function withInvoiceConfig(config: Partial<MeConfig['modules'][string]['config']>) {
  useAuthStore.getState().setSession('tok', { id: 'u1', email: 'u@e.com', name: 'U', role: 'OWNER', shopId: 's1', companyId: 'c1', permissions: [] });
  useAuthStore.getState().setMeConfig({
    userId: 'u1',
    etag: null,
    data: {
      version: 1,
      modules: { invoices: { usable: true, label: 'Invoices', config: { mandatoryFields: [], hiddenFields: [], ...config } } },
      sidebar: [],
      preferences: {},
    },
  });
}

const renderCreate = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/invoices/new']}>
        <InvoicesPage createOnly />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('InvoicesPage with organisation field config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().clear();
  });

  it('shows due date and remarks as optional with no config (today)', () => {
    renderCreate();
    expect(screen.getByLabelText('Due Date')).not.toBeRequired();
    expect(screen.getByLabelText('Remarks')).toBeInTheDocument();
  });

  it('leaves hidden fields out of the form and the payload', async () => {
    withInvoiceConfig({ hiddenFields: ['remarks'] });
    mutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderCreate();
    expect(screen.queryByLabelText('Remarks')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Select customer'), 'cu1');
    await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
    expect(mutateAsync).toHaveBeenCalledWith(expect.not.objectContaining({ remarks: expect.anything() }));
  });

  it('marks mandatory fields and blocks creating without them', async () => {
    withInvoiceConfig({ mandatoryFields: ['dueDate'] });
    const user = userEvent.setup();
    renderCreate();
    expect(screen.getByLabelText('Due Date *')).toBeRequired();

    await user.selectOptions(screen.getByLabelText('Select customer'), 'cu1');
    await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
    expect(toast.error).toHaveBeenCalledWith('Fill in the required field: Due Date');
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
