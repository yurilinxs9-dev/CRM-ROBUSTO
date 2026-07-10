'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Search, MessageSquare, CornerDownLeft } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { NAV_ITEMS } from '@/components/layout/sidebar';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

interface LeadHit {
  id: string;
  nome: string;
  telefone: string;
  foto_url?: string | null;
}

function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/**
 * Paleta de comandos global (Ctrl+K / Cmd+K) — Onda 4 da auditoria UI.
 * Navegação por página + busca de lead por nome/telefone com ir-pro-chat.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  // Mesmo filtro de visibilidade do sidebar.
  const nav = NAV_ITEMS.filter(
    (item) =>
      !(item.href === '/chat' && role === 'VISUALIZADOR') &&
      !(item.href === '/followup' && role !== 'SUPER_ADMIN' && role !== 'GERENTE'),
  );

  const enabled = open && query.trim().length >= 2;
  const { data: leads = [], isFetching } = useQuery<LeadHit[]>({
    queryKey: ['cmdk-leads', query],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', {
        params: { search: query.trim(), limit: 6 },
      });
      return Array.isArray(data) ? data : (data?.data ?? []);
    },
    enabled,
    staleTime: 10_000,
  });

  const run = (fn: () => void) => {
    setOpen(false);
    setQuery('');
    fn();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 shadow-elev-3 sm:max-w-lg">
        <DialogTitle className="sr-only">Paleta de comandos</DialogTitle>
        <Command shouldFilter={query.trim().length < 2} className="bg-transparent">
          <div className="flex items-center gap-2 border-b border-line-1 px-3">
            <Search size={15} className="shrink-0 text-ink-3" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Buscar lead, ir para página…"
              className="h-12 w-full bg-transparent text-sm text-ink-1 outline-none placeholder:text-ink-3"
            />
            <kbd className="rounded border border-line-2 px-1.5 py-0.5 text-[10px] text-ink-3">
              ESC
            </kbd>
          </div>
          <Command.List className="max-h-80 overflow-y-auto scrollbar-thin p-2">
            <Command.Empty className="py-8 text-center text-sm text-ink-3">
              {isFetching ? 'Buscando…' : 'Nada encontrado.'}
            </Command.Empty>

            {leads.length > 0 && (
              <Command.Group
                heading="Leads"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-3"
              >
                {leads.map((l) => (
                  <Command.Item
                    key={l.id}
                    value={`lead-${l.id}`}
                    onSelect={() => run(() => router.push(`/chat/${l.id}`))}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm text-ink-1 aria-selected:bg-brand-subtle aria-selected:text-ink-1"
                  >
                    <Avatar className="h-6 w-6">
                      {l.foto_url && <AvatarImage src={l.foto_url} alt={l.nome} />}
                      <AvatarFallback className="text-[9px]">{initials(l.nome)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate">{l.nome}</span>
                    <span className="tnum text-xs text-ink-3">{l.telefone}</span>
                    <MessageSquare size={13} className="text-ink-3" />
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group
              heading="Ir para"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-3"
            >
              {nav.map((item) => (
                <Command.Item
                  key={item.href}
                  value={`nav ${item.label}`}
                  onSelect={() => run(() => router.push(item.href))}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm text-ink-2 aria-selected:bg-brand-subtle aria-selected:text-ink-1 group"
                >
                  <item.icon size={15} className="text-ink-3" />
                  <span className="flex-1">{item.label}</span>
                  <CornerDownLeft size={12} className="opacity-0 group-aria-selected:opacity-60" />
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
