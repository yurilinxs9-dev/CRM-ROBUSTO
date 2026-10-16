'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { useAuthStore, type Tenant } from '@/stores/auth.store';
import { userFromAuthMe, type AuthMeProfile } from '@/lib/auth-user';
import { api } from '@/lib/api';

function AuthBootstrap() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const tenant = useAuthStore((s) => s.tenant);
  const setTenant = useAuthStore((s) => s.setTenant);
  const updateUser = useAuthStore((s) => s.updateUser);

  useEffect(() => {
    if (!isAuthenticated || tenant !== null) return;
    let cancelled = false;
    api.get<AuthMeProfile & { tenant: Tenant }>('/api/auth/me')
      .then(({ data }) => {
        if (cancelled || useAuthStore.getState().accessToken !== accessToken) return;
        updateUser(userFromAuthMe(data));
        setTenant(data.tenant);
      })
      .catch(() => { /* token expirado ou rede — não-crítico */ });
    return () => { cancelled = true; };
  }, [isAuthenticated, accessToken, tenant, setTenant, updateUser]);

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
