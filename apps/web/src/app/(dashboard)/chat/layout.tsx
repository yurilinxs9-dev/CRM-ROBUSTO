'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Route guard for /chat:
 * VISUALIZADOR nao tem acesso a conversas — redireciona ao dashboard.
 * Demais papeis passam normalmente.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { user, hydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!hydrated) return;
    if (user?.role === 'VISUALIZADOR') {
      router.replace('/dashboard');
    }
  }, [hydrated, user?.role, router]);

  if (user?.role === 'VISUALIZADOR') return null;
  return <>{children}</>;
}
