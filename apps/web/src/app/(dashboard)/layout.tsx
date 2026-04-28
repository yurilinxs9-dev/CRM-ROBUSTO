'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TaskNotifications } from '@/components/layout/task-notifications';
import { NotificationPrompt } from '@/components/notification-prompt';
import { connectSocket, disconnectSocket, reconnectSocket } from '@/lib/socket';
import { api } from '@/lib/api';

/**
 * Decode a JWT payload and return the `exp` timestamp (seconds).
 * Returns 0 on any parsing error.
 */
function getTokenExp(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (payload.exp as number) ?? 0;
  } catch {
    return 0;
  }
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { accessToken, isAuthenticated, hydrated, updateToken } = useAuthStore();
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wait for zustand persist to rehydrate from localStorage BEFORE deciding
  // whether to redirect — otherwise a hard refresh always bounces the user
  // to /login on the first render, even with a valid stored token.
  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated && !accessToken) {
      router.push('/login');
    }
  }, [hydrated, isAuthenticated, accessToken, router]);

  /**
   * Proactively refresh the access token. Returns the new token or null on failure.
   */
  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    try {
      const { data } = await api.post('/api/auth/refresh');
      const newToken = data.accessToken as string;
      updateToken(newToken);
      return newToken;
    } catch {
      return null;
    }
  }, [updateToken]);

  /**
   * Schedule the next token refresh at ~80% of the remaining lifetime.
   * Example: token expires in 15 min → refresh at ~12 min.
   */
  const scheduleRefresh = useCallback(
    (token: string) => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);

      const exp = getTokenExp(token);
      if (!exp) return;

      const nowSec = Math.floor(Date.now() / 1000);
      const remainingSec = exp - nowSec;
      // Refresh when 80% of the token's lifetime has elapsed, minimum 30s.
      const delayMs = Math.max(remainingSec * 0.8, 30) * 1000;

      refreshTimerRef.current = setTimeout(async () => {
        const newToken = await refreshAccessToken();
        if (newToken) {
          reconnectSocket(newToken);
          scheduleRefresh(newToken);
        }
      }, delayMs);
    },
    [refreshAccessToken],
  );

  // Connect socket and schedule proactive refresh whenever the token changes.
  useEffect(() => {
    if (!accessToken) return;
    connectSocket(accessToken);
    scheduleRefresh(accessToken);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      disconnectSocket();
    };
  }, [accessToken, scheduleRefresh]);

  // When the tab becomes visible again, immediately check if the token is
  // expired or close to expiring and refresh + reconnect socket if needed.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      const token = useAuthStore.getState().accessToken;
      if (!token) return;

      const exp = getTokenExp(token);
      const nowSec = Math.floor(Date.now() / 1000);
      // Refresh if token expires within the next 2 minutes.
      if (exp && exp - nowSec < 120) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          reconnectSocket(newToken);
          scheduleRefresh(newToken);
        }
      } else {
        // Token still valid — but socket may have disconnected while tab
        // was hidden (browser throttles timers). Reconnect if needed.
        const { getSocket } = await import('@/lib/socket');
        const s = getSocket();
        if (!s.connected && token) {
          reconnectSocket(token);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshAccessToken, scheduleRefresh]);

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
      <NotificationPrompt />
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
