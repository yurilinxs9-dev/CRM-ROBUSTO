'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TaskNotifications } from '@/components/layout/task-notifications';
import { connectSocket, disconnectSocket } from '@/lib/socket';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { accessToken, isAuthenticated, hydrated } = useAuthStore();
  const router = useRouter();

  // Wait for zustand persist to rehydrate from localStorage BEFORE deciding
  // whether to redirect — otherwise a hard refresh always bounces the user
  // to /login on the first render, even with a valid stored token.
  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated && !accessToken) {
      router.push('/login');
    }
  }, [hydrated, isAuthenticated, accessToken, router]);

  // Mantém o Socket.IO conectado durante toda a sessao do dashboard.
  // Sem isso, o socket so conecta quando o usuario abre uma conversa,
  // entao a lista de chats nao recebe `lead:new-message` em tempo real
  // e o usuario precisa clicar em "Sincronizar" para ver mensagens novas.
  // IMPORTANTE: mantem TODOS os hooks antes de qualquer `return` condicional
  // pra evitar React error #310 (hooks order mismatch) no flip de hydrated.
  useEffect(() => {
    if (!accessToken) return;
    connectSocket(accessToken);
    return () => {
      disconnectSocket();
    };
  }, [accessToken]);

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <TaskNotifications />
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <div className="hidden md:block">
          <Sidebar />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main className="flex-1 overflow-auto bg-background">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
