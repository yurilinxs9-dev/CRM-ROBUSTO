'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getSocket, joinLead, leaveLead } from '@/lib/socket';
import { ChatHeader } from '@/components/chat/chat-header';
import { ChatComposer } from '@/components/chat/chat-composer';
import { MessageBubble } from '@/components/chat/message-bubble';
import { LeadDetailsSheet } from '@/components/chat/lead-details-sheet';
import {
  ChatLead,
  ChatMessage,
  ChatPipeline,
  MessageStatus,
  MessagesPage,
  formatDateSeparator,
  getDateKey,
} from '@/components/chat/types';

interface MessagesQueryData {
  pages: MessagesPage[];
  pageParams: (string | undefined)[];
}

export default function ChatDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const leadId = params.id as string;

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // --- Queries ---
  const { data: currentLead } = useQuery<ChatLead>({
    queryKey: ['lead', leadId],
    queryFn: async () => {
      const res = await api.get(`/api/leads/${leadId}`);
      return res.data;
    },
    enabled: !!leadId,
  });

  const { data: pipelines = [] } = useQuery<ChatPipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
  });

  const stages = useMemo(
    () => [...(pipelines[0]?.stages ?? [])].sort((a, b) => a.ordem - b.ordem),
    [pipelines],
  );

  const {
    data: messagesData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<MessagesPage>({
    queryKey: ['messages', leadId],
    queryFn: async ({ pageParam }) => {
      const qp: Record<string, string> = { limit: '30' };
      if (pageParam) qp.cursor = pageParam as string;
      const res = await api.get(`/api/leads/${leadId}/messages`, { params: qp });
      return res.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!leadId,
  });

  const messages = useMemo(() => {
    if (!messagesData?.pages) return [] as ChatMessage[];
    const all: ChatMessage[] = [];
    for (let i = messagesData.pages.length - 1; i >= 0; i--) {
      all.push(...(messagesData.pages[i].messages ?? []));
    }
    all.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return all;
  }, [messagesData]);

  const groupedMessages = useMemo(() => {
    const groups: { key: string; label: string; messages: ChatMessage[] }[] = [];
    let currentKey = '';
    for (const msg of messages) {
      const key = getDateKey(msg.created_at);
      if (key !== currentKey) {
        currentKey = key;
        groups.push({
          key,
          label: formatDateSeparator(msg.created_at),
          messages: [msg],
        });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [messages]);

  // --- Mutations ---
  const sendTextMutation = useMutation({
    mutationFn: async ({
      content,
      isNote,
    }: {
      content: string;
      isNote: boolean;
    }) => {
      if (isNote) {
        const res = await api.post(`/api/leads/${leadId}/messages`, {
          content,
          is_internal_note: true,
        });
        return res.data;
      }
      const res = await api.post('/api/messages/send-text', {
        lead_id: leadId,
        content,
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', leadId] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? 'Erro ao enviar mensagem.';
      toast.error(msg);
    },
  });

  const sendAudioMutation = useMutation({
    mutationFn: async (blob: Blob) => {
      const fd = new FormData();
      fd.append('file', blob, 'audio.webm');
      fd.append('lead_id', leadId);
      const res = await api.post('/api/messages/send-audio', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Áudio enviado');
      queryClient.invalidateQueries({ queryKey: ['messages', leadId] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? 'Erro ao enviar áudio.';
      toast.error(msg);
    },
  });

  const sendMediaMutation = useMutation({
    mutationFn: async ({
      file,
      caption,
    }: {
      file: File;
      caption?: string;
    }) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('lead_id', leadId);
      if (caption) fd.append('caption', caption);
      const res = await api.post('/api/messages/send-media', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Mídia enviada');
      queryClient.invalidateQueries({ queryKey: ['messages', leadId] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? 'Erro ao enviar mídia.';
      toast.error(msg);
    },
  });

  const moveStageMutation = useMutation({
    mutationFn: async (estagioId: string) => {
      await api.patch(`/api/leads/${leadId}/stage`, { estagio_id: estagioId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast.success('Etapa atualizada');
    },
    onError: () => toast.error('Erro ao mover etapa.'),
  });

  const markReadMutation = useMutation({
    mutationFn: async () => {
      await api.patch(`/api/leads/${leadId}/mark-read`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    },
  });

  const deleteLeadMutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/api/leads/${leadId}`);
    },
    onSuccess: () => {
      toast.success('Lead excluído');
      router.push('/chat');
    },
    onError: () => toast.error('Erro ao excluir lead.'),
  });

  // --- Mark as read on mount ---
  useEffect(() => {
    if (!leadId) return;
    markReadMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // --- Socket ---
  useEffect(() => {
    if (!leadId) return;
    joinLead(leadId);
    const socket = getSocket();

    const handleNew = (data: ChatMessage) => {
      if (data.lead_id !== leadId) return;
      queryClient.setQueryData<MessagesQueryData>(
        ['messages', leadId],
        (old) => {
          if (!old || old.pages.length === 0) return old;
          const pages = [...old.pages];
          const last = { ...pages[pages.length - 1] };
          // Dedup by id
          if (last.messages.some((m) => m.id === data.id)) return old;
          last.messages = [...last.messages, data];
          pages[pages.length - 1] = last;
          return { ...old, pages };
        },
      );
      if (data.direction === 'INCOMING' || data.direction === 'INBOUND') {
        markReadMutation.mutate();
      }
    };

    const handleStatus = (evt: { messageId: string; status: MessageStatus }) => {
      queryClient.setQueryData<MessagesQueryData>(
        ['messages', leadId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              messages: p.messages.map((m) =>
                m.id === evt.messageId ? { ...m, status: evt.status } : m,
              ),
            })),
          };
        },
      );
    };

    socket.on('message:new', handleNew);
    socket.on('message:status-updated', handleStatus);

    return () => {
      leaveLead(leadId);
      socket.off('message:new', handleNew);
      socket.off('message:status-updated', handleStatus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, queryClient]);

  // --- Auto-scroll on new message ---
  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lastMessageId]);

  // --- Infinite scroll up for older messages ---
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (container.scrollTop < 80 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // --- Composer handlers ---
  const handleSendText = useCallback(
    (content: string, isNote: boolean) => {
      sendTextMutation.mutate({ content, isNote });
    },
    [sendTextMutation],
  );

  const handleSendAudio = useCallback(
    (blob: Blob) => {
      toast.loading('Enviando áudio…', { id: 'audio-upload' });
      sendAudioMutation.mutate(blob, {
        onSettled: () => toast.dismiss('audio-upload'),
      });
    },
    [sendAudioMutation],
  );

  const handleSendMedia = useCallback(
    (file: File, caption: string | undefined) => {
      toast.loading('Enviando mídia…', { id: 'media-upload' });
      sendMediaMutation.mutate(
        { file, caption },
        { onSettled: () => toast.dismiss('media-upload') },
      );
    },
    [sendMediaMutation],
  );

  const handleClearConversation = () => {
    toast.info('Limpar conversa: em breve.');
  };

  const handleDeleteLead = () => {
    if (!confirm('Deseja excluir este lead? Esta ação não pode ser desfeita.')) {
      return;
    }
    deleteLeadMutation.mutate();
  };

  const sending =
    sendTextMutation.isPending ||
    sendAudioMutation.isPending ||
    sendMediaMutation.isPending;

  return (
    <div className="flex h-full flex-col bg-background">
      {currentLead && (
        <ChatHeader
          lead={currentLead}
          stages={stages}
          onStageChange={(id) => moveStageMutation.mutate(id)}
          onOpenDetails={() => setDetailsOpen(true)}
          onMarkRead={() => markReadMutation.mutate()}
          onClearConversation={handleClearConversation}
          onDeleteLead={handleDeleteLead}
        />
      )}

      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Histórico de mensagens"
        className="flex-1 overflow-y-auto bg-muted/20 px-3 py-4 sm:px-6"
      >
        {isFetchingNextPage && (
          <div className="py-2 text-center text-[11px] text-muted-foreground">
            Carregando mensagens anteriores…
          </div>
        )}
        {hasNextPage && !isFetchingNextPage && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={() => fetchNextPage()}
              className="rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted"
            >
              Carregar anteriores
            </button>
          </div>
        )}

        {groupedMessages.map((group) => (
          <div key={group.key}>
            <div className="my-4 flex items-center justify-center">
              <span className="rounded-full bg-card px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm">
                {group.label}
              </span>
            </div>
            {group.messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        ))}

        {messages.length === 0 && !isFetchingNextPage && (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center">
            <MessageCircle size={40} className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Nenhuma mensagem ainda
            </p>
            <p className="text-xs text-muted-foreground">
              Envie a primeira mensagem para iniciar a conversa
            </p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <ChatComposer
        disabled={!currentLead}
        sending={sending}
        onSendText={handleSendText}
        onSendAudio={handleSendAudio}
        onSendMedia={handleSendMedia}
      />

      <LeadDetailsSheet
        lead={currentLead ?? null}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </div>
  );
}
