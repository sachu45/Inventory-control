import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommandSpotlight } from './CommandSpotlight';
import { api } from '@/api/client';
import { useAuthStore } from '@/store/authStore';
vi.mock('@/api/client', () => ({ api:{ get:vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); useAuthStore.setState({ user:{ id:'employee', companyId:'company-1', email:'employee@example.test', name:'Employee', role:'EMPLOYEE', shopId:'s1', permissions:['product:read'] } }); });
function Destination() { const location = useLocation(); return <p>{location.pathname + location.search}</p>; }
function setup() {
  const client = new QueryClient({ defaultOptions:{ queries:{ retry:false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route path="/" element={<CommandSpotlight open onOpenChange={vi.fn()} />} /><Route path="/products" element={<Destination />} /></Routes></MemoryRouter></QueryClientProvider>);
  return userEvent.setup();
}
describe('workspace record search', () => {
  it('searches the permitted API and opens the matching record', async () => {
    vi.mocked(api.get).mockResolvedValue({ data:{ data:[{ id:'p1', productCode:'SKU-1', description:'Alpha item' }] } });
    const user = setup(); await user.type(screen.getByRole('textbox', { name:'Search records and pages' }), 'Alpha');
    const result = await screen.findByRole('button', { name:/Alpha item/ });
    expect(api.get).toHaveBeenCalledWith('/products', expect.objectContaining({ params:expect.objectContaining({ search:'Alpha', limit:6 }) }));
    expect(api.get).not.toHaveBeenCalledWith('/customers', expect.anything());
    expect(api.get).not.toHaveBeenCalledWith('/suppliers', expect.anything());
    await user.click(result);
    expect(await screen.findByText('/products?search=SKU-1&record=p1')).toBeInTheDocument();
  });
  it('keeps available records when another permitted module fails', async () => {
    useAuthStore.setState({ user:{ ...useAuthStore.getState().user!, role:'OWNER' } });
    vi.mocked(api.get).mockImplementation(async path => {
      if (path === '/customers') throw new Error('Unavailable');
      return { data:{ data:path === '/products' ? [{ id:'p1', productCode:'SKU-1', description:'Alpha item' }] : [] } };
    });
    const user = setup(); await user.type(screen.getByRole('textbox', { name:'Search records and pages' }), 'Alpha');
    await screen.findByRole('button', { name:/Alpha item/ });
    await waitFor(() => expect(screen.getByText(/Some records could not be searched/)).toBeInTheDocument());
  });
});
