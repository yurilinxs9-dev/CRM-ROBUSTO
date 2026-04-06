'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareOff, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';

import { ChatListItem, type ChatLead } from '@/components/chat/chat-list-item';
import {
  NewChatDialog,
  type NewChatFormData,
  type Pipeline,
} from '@/components/chat/new-chat-dialog';

type FilterTab = 'all' | 'unread' | 'mine';

const LEADS_QUERY_KEY = ['chat', 'leads'] as const;

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<FilterTab>('all');
  const [dialogOpen, setDialogOpen] = useState(false);

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
  });

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
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
    const term = search.trim().toLowerCase();
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
  }, [leads, search, tab, currentUser?.id]);

  const totalCount = leads.length;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-border">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold text-foreground">Conversas</h1>
            <span className="text-xs text-muted-foreground tabular-nums">
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
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder="Buscar por nome ou telefone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as FilterTab)}>
          <TabsList className="grid w-full grid-cols-3 h-9">
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

      {/* List */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <Skeleton className="h-11 w-11 rounded-full flex-shrink-0" />
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
          <div className="flex flex-col items-center justify-center py-16 gap-3 px-6 text-center">
            <MessageSquareOff className="h-10 w-10 text-muted-foreground/60" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Nenhuma conversa encontrada
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {search || tab !== 'all'
                  ? 'Ajuste os filtros ou a busca'
                  : 'Crie uma nova conversa para começar'}
              </p>
            </div>
          </div>
        ) : (
          <div>
            {filteredLeads.map((lead) => (
              <ChatListItem
                key={lead.id}
                lead={lead}
                active={lead.id === activeChatId}
                onClick={() => router.push(`/chat/${lead.id}`)}
              />
            ))}
          </div>
        )}
      </ScrollArea>

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
