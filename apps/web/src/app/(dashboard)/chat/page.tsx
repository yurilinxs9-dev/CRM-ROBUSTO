'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageSquareOff, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';

import { ChatListItem, type ChatLead } from '@/components/chat/chat-list-item';
import {
  NewChatDialog,
  type NewChatFormData,
  type Pipeline,
} from '@/components/chat/new-chat-dialog';

type FilterTab = 'all' | 'unread' | 'mine';

const LEADS_QUERY_KEY = ['chat', 'leads'] as const;
const LEADS_STALE = 30_000;
const ROW_HEIGHT = 76;
const SEARCH_DEBOUNCE_MS = 200;

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tab, setTab] = useState<FilterTab>('all');
  const [dialogOpen, setDialogOpen] = useState(false);

  // Debounce search input to avoid filtering on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [search]);

  // Derive active chat id from URL (/chat/[id])
  const activeChatId = useMemo(() => {
    const match = pathname?.match(/^\/chat\/([^/]+)/);
    return match?.[1] ?? null;
  }, [pathname]);

  // --- Queries ---
  const { data: leads = [], isLoading } = useQuery<ChatLead[]>({
    queryKey: LEADS_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get('/api/leads');
      return res.data;
    },
    staleTime: LEADS_STALE,
  });

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
    staleTime: 5 * 60_000,
  });

  // --- Mutations ---
  const createLeadMutation = useMutation({
    mutationFn: async (data: NewChatFormData) => {
      const res = await api.post('/api/leads', {
        ...data,
        temperatura: 'FRIO',
      });
      return res.data as ChatLead;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
      setDialogOpen(false);
      toast.success('Conversa criada');
      router.push(`/chat/${data.id}`);
    },
    onError: () => {
      toast.error('Erro ao criar conversa');
    },
  });

  // --- Socket realtime ---
  useEffect(() => {
    const socket = getSocket();

    const handleNewMessage = () => {
      queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    };

    socket.on('lead:new-message', handleNewMessage);
    return () => {
      socket.off('lead:new-message', handleNewMessage);
    };
  }, [queryClient]);

  // --- Filtering + sorting ---
  const filteredLeads = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    const digits = term.replace(/\D/g, '');

    let list = leads.filter((lead) => {
      if (tab === 'unread' && lead.mensagens_nao_lidas <= 0) return false;
      if (tab === 'mine' && lead.responsavel?.id !== currentUser?.id) return false;

      if (term) {
        const nameMatch = lead.nome.toLowerCase().includes(term);
        const phoneMatch = digits
          ? lead.telefone.replace(/\D/g, '').includes(digits)
          : false;
        if (!nameMatch && !phoneMatch) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      if (tab === 'unread') {
        if (b.mensagens_nao_lidas !== a.mensagens_nao_lidas) {
          return b.mensagens_nao_lidas - a.mensagens_nao_lidas;
        }
      }
      const dateA = a.ultima_interacao ? new Date(a.ultima_interacao).getTime() : 0;
      const dateB = b.ultima_interacao ? new Date(b.ultima_interacao).getTime() : 0;
      return dateB - dateA;
    });

    return list;
  }, [leads, debouncedSearch, tab, currentUser?.id]);

  const totalCount = leads.length;

  // --- Virtualization ---
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filteredLeads.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border px-4 pb-3 pt-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold text-foreground">Conversas</h1>
            <span className="text-xs tabular-nums text-muted-foreground">
              {totalCount}
            </span>
          </div>
          <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            Nova conversa
          </Button>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Buscar por nome ou telefone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9"
          />
        </div>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as FilterTab)}>
          <TabsList className="grid h-9 w-full grid-cols-3">
            <TabsTrigger value="all" className="text-xs">
              Todas
            </TabsTrigger>
            <TabsTrigger value="unread" className="text-xs">
              Não lidas
            </TabsTrigger>
            <TabsTrigger value="mine" className="text-xs">
              Minhas
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Virtualized List */}
      <div ref={scrollParentRef} className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <Skeleton className="h-11 w-11 flex-shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="flex justify-between">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-10" />
                  </div>
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-2.5 w-28" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <MessageSquareOff className="h-10 w-10 text-muted-foreground/60" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Nenhuma conversa encontrada
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {debouncedSearch || tab !== 'all'
                  ? 'Ajuste os filtros ou a busca'
                  : 'Crie uma nova conversa para começar'}
              </p>
            </div>
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const lead = filteredLeads[vItem.index];
              return (
                <div
                  key={lead.id}
                  data-index={vItem.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vItem.start}px)` }}
                >
                  <ChatListItem
                    lead={lead}
                    active={lead.id === activeChatId}
                    onClick={() => router.push(`/chat/${lead.id}`)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <NewChatDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        pipelines={pipelines}
        isLoading={createLeadMutation.isPending}
        onSubmit={(data) => createLeadMutation.mutate(data)}
      />
    </div>
  );
}
