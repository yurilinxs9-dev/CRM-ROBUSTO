'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell, Menu, Search } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Sidebar, NAV_ITEMS } from './sidebar';
import { UserMenu } from './user-menu';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

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
  const qc = useQueryClient();

  const { data: overdue = [] } = useQuery<Array<{ id: string; titulo: string }>>({
    queryKey: ['tasks', 'overdue'],
    queryFn: async () => (await api.get('/api/tasks/overdue')).data,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const s = getSocket();
    const onOverdue = (p: { taskId: string; titulo: string }) => {
      toast.warning(`Tarefa atrasada: ${p.titulo}`);
      qc.invalidateQueries({ queryKey: ['tasks'] });
    };
    const onMutate = () => qc.invalidateQueries({ queryKey: ['tasks'] });
    s.on('task:overdue', onOverdue);
    s.on('task:created', onMutate);
    s.on('task:updated', onMutate);
    return () => {
      s.off('task:overdue', onOverdue);
      s.off('task:created', onMutate);
      s.off('task:updated', onMutate);
    };
  }, [qc]);

  const count = overdue.length;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6">
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

      <div className="flex-1" />

      {/* Quick search */}
      <div className="relative hidden md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Buscar..."
          aria-label="Buscar"
          className="h-9 w-64 pl-9"
        />
      </div>

      {/* Notifications */}
      <Button variant="ghost" size="icon" className="relative" aria-label="Notificações">
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </Button>

      <UserMenu variant="icon" />
    </header>
  );
}
