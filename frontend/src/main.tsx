import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import App from './App.tsx';
import { queryClient } from './api/queryClient';
import { installUnauthorizedHandler } from './auth/session-store';

installUnauthorizedHandler();

// BrowserRouter is wired now even though App.tsx has no <Routes> yet —
// Phase 1 has no real screens to route to. Phase 2+ maps routes 1:1 to
// the locked UI_UX_DESIGN.md §5.1.4 sitemap on top of this.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
