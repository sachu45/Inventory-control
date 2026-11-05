import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleOnboardingPage } from './GoogleOnboardingPage';
import { api } from '@/api/client';
import { startGoogleOnboarding } from '@/lib/google-onboarding';

const { checkout } = vi.hoisted(() => ({ checkout: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/google-onboarding', () => ({ startGoogleOnboarding: vi.fn() }));
vi.mock('@/hooks/use-razorpay-checkout', () => ({ useRazorpayCheckout: () => ({ checkout, loading: false }) }));
vi.mock('@/lib/session', () => ({ initializeSessionFromAuthResponse: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });
const state = (overrides = {}) => ({ status: 'WORKSPACE_SETUP_PENDING', plan: 'pro', billing: 'monthly', amountPaise: 39900, taxPaise: 0, loginOnly: false, user: { name: 'Person', email: 'person@example.com', picture: null }, linkRequired: false, securityRequired: true, mfaEnabled: false, workspaceReady: false, ...overrides });
function setup(path = '/signup/google/continue') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><GoogleOnboardingPage /></MemoryRouter></QueryClientProvider>);
  return userEvent.setup();
}
describe('Google-first onboarding UI', () => {
  it.each(['pro', 'plus'])('starts %s authentication without showing the old registration fields', async plan => {
    vi.mocked(startGoogleOnboarding).mockResolvedValue(undefined);
    setup(`/signup/google?plan=${plan}&billing=yearly`);
    await waitFor(() => expect(startGoogleOnboarding).toHaveBeenCalledWith({ plan, billing: 'yearly' }));
    expect(startGoogleOnboarding).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Company address')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
  });
  it('reports missing provider configuration without simulating successful authentication', async () => {
    vi.mocked(startGoogleOnboarding).mockRejectedValue(new Error('Google signup is not configured.'));
    setup('/signup/google?plan=pro');
    expect(await screen.findByRole('alert')).toHaveTextContent('not configured');
    expect(screen.queryByText('Your account is ready.')).not.toBeInTheDocument();
  });
  it('shows cancellation recovery actions', () => {
    setup('/signup/google/continue?error=cancelled');
    expect(screen.getByRole('alert')).toHaveTextContent('cancelled');
    expect(screen.getByRole('link', { name: 'Choose a plan' })).toBeVisible();
    expect(api.get).not.toHaveBeenCalled();
  });
  it('requests only a workspace name, optional company name and terms, without assuming a company name', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: state() } });
    const user = setup();
    const name = await screen.findByLabelText('Workspace name');
    expect(screen.getByLabelText(/Company name/)).toHaveValue('');
    const button = screen.getByRole('button', { name: 'Create workspace' });
    expect(button).toBeDisabled();
    await user.type(name, 'Central warehouse');
    await user.click(screen.getByRole('checkbox'));
    await user.click(button);
    expect(api.post).toHaveBeenCalledWith('/auth/onboarding/workspace', { workspaceName: 'Central warehouse', companyName: undefined, agreedToTerms: true });
  });
  it('requires existing-password proof for a matching email', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: state({ linkRequired: true }) } });
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true } });
    const user = setup();
    await user.type(await screen.findByLabelText('Existing account password'), 'current-password');
    await user.click(screen.getByRole('button', { name: 'Verify and link account' }));
    expect(api.post).toHaveBeenCalledWith('/auth/onboarding/link', { password: 'current-password' });
  });
  it('keeps checkout unavailable until required security enrollment is complete', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: state({ workspaceReady: true }) } });
    setup();
    expect(await screen.findByText('Protect your administrator account')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Continue to payment/ })).not.toBeInTheDocument();
  });
  it('uses server-held pricing and the protected payment verification endpoint', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: state({ workspaceReady: true, securityRequired: false, status: 'CHECKOUT_PENDING' }) } });
    checkout.mockResolvedValue(undefined);
    const user = setup();
    await user.click(await screen.findByRole('button', { name: /Continue to payment/ }));
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ serverIntent: true, orderEndpoint: '/auth/onboarding/checkout', verifyEndpoint: '/auth/onboarding/payment/verify' }));
    expect(screen.getByText(/Renewal is manual/)).toBeVisible();
    expect(api.post).not.toHaveBeenCalledWith('/auth/onboarding/finish');
  });
  it('only offers ERP entry when the backend reports an active subscription', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: state({ workspaceReady: true, securityRequired: false, status: 'SUBSCRIPTION_ACTIVE' }) } });
    setup();
    expect(await screen.findByRole('button', { name: 'Start using the ERP' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Continue to payment/ })).not.toBeInTheDocument();
  });
  it('shows expired-session errors with a safe recovery path', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Signup intent expired.'));
    setup(); expect(await screen.findByRole('alert')).toHaveTextContent('expired');
  });
});
