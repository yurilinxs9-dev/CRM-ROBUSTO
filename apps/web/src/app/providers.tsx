'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // staleTime alto evita refetch toda navegacao — dados chegam
            // via socket, nao precisa revalidar por polling.
            staleTime: 5 * 60_000,
            gcTime: 10 * 60_000,
            refetchOnWindowFocus: false,
            refetchOnMount: false,
            refetchOnReconnect: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--bg-surface-3)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
          },
        }}
      />
    </QueryClientProvider>
  );
}
