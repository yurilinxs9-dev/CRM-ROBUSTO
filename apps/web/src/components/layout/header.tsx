'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Sidebar, NAV_ITEMS } from './sidebar';
import { HeaderSearch } from './header-search';
import { NotificationBell } from './notification-bell';
import { UserMenu } from './user-menu';
import { useSocketStatus } from '@/hooks/use-socket-status';

function usePageTitle() {
  const pathname = usePathname();
  const match = NAV_ITEMS.find((n) =>
    n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(`${n.href}/`),
  );
  return match?.label ?? 'CRM Pro';
}

export function Header() {
  const [open, setOpen] = useState(false);
  const title = usePageTitle();
  const connected = useSocketStatus();

  return (
    <header
      className="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Mobile sidebar trigger */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Abrir menu">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[260px] p-0">
          <SheetTitle className="sr-only">Menu de navegacao</SheetTitle>
          <SheetDescription className="sr-only">Navegacao principal do CRM</SheetDescription>
          <Sidebar onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>

      {!connected && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}
          title="Reconectando ao tempo real"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="hidden sm:inline">Reconectando…</span>
        </span>
      )}

      <div className="flex-1" />

      <HeaderSearch />
      <NotificationBell />
      <UserMenu variant="icon" />
    </header>
  );
}
