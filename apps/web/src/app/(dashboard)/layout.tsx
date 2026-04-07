'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TaskNotifications } from '@/components/layout/task-notifications';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { accessToken, isAuthenticated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated && !accessToken) {
      router.push('/login');
    }
  }, [isAuthenticated, accessToken, router]);

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
