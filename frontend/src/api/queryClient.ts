import { QueryClient } from '@tanstack/react-query';

/**
 * Single app-wide instance so both `main.tsx`'s <QueryClientProvider>
 * and the session store (which needs to call `.clear()` on 401 and on
 * `switchOrganization`) share the same cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
