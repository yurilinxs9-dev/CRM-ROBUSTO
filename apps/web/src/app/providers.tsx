'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

function AuthBootstrap() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenant = useAuthStore((s) => s.tenant);
  const setTenant = useAuthStore((s) => s.setTenant);

  useEffect(() => {
    if (!isAuthenticated || tenant !== null) return;
    api.get<{ user: unknown; tenant: { id: string; nome: string; pool_enabled: boolean } }>('/api/auth/me')
      .then((res) => setTenant(res.data.tenant))
      .catch(() => { /* token expirado ou rede — não-crítico */ });
  }, [isAuthenticated, tenant, setTenant]);

  return null;
}

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
      <AuthBootstrap />
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
