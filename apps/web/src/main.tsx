import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { AppRoutes } from './routes/AppRoutes';
import './index.css';
import './workspace.css';
import './enterprise.css';
import { GoogleAnalyticsManager } from './components/analytics/GoogleAnalyticsManager';
import { DocumentTitleManager } from './components/DocumentTitleManager';
import { CookieConsentManager } from './components/cookies/CookieConsentManager';
import { bootstrapSession } from './lib/bootstrap-session';
import { armChunkReloadRecovery } from './lib/chunk-reload';
import { useAuthStore } from './store/authStore';
import { initThemeFromStorage } from './store/themeStore';

initThemeFromStorage();

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function restoreAuthFromStorage() {
  if (typeof window === 'undefined') return;

  try {
    const stored = window.localStorage.getItem('retail-ims-auth-state');
    if (stored) {
      const state = JSON.parse(stored);
      if (state.state?.accessToken) {
        useAuthStore.getState().setSession(state.state.accessToken, state.state.user);
      }
    }
  } catch (e) {
    console.error('Failed to restore auth from storage:', e);
  }
}

async function init() {
  // Restore auth from localStorage immediately (Zustand persist middleware will also do this)
  restoreAuthFromStorage();
  // setSession restores cached identity and marks it initialized. Keep protected
  // routes behind the startup check until the rotating refresh cookie settles.
  // Otherwise navigation can interrupt a refresh after its old cookie was used.
  useAuthStore.getState().setInitialized(false);

  function mountApp() {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <DocumentTitleManager />
            <AppRoutes />
            <GoogleAnalyticsManager />
            <CookieConsentManager />
            {import.meta.env.VITE_ON_VERCEL && <SpeedInsights />}
          </BrowserRouter>
        </QueryClientProvider>
      </React.StrictMode>,
    );
  }

  mountApp();
  await bootstrapSession();
  // Re-arm the stale-chunk auto-reload guard once we've run stably, so a later
  // deploy can recover again without risking a reload loop.
  armChunkReloadRecovery();
}

init().catch(console.error);
