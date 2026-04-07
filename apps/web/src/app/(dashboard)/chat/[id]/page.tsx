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
import { Skeleton } from '@/components/ui/skeleton';
import { ChatHeader } from '@/components/chat/chat-header';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatWallpaper } from '@/components/chat/chat-wallpaper';
import { MessageBubble } from '@/components/chat/message-bubble';
import { TypingIndicator } from '@/components/chat/typing-indicator';
import { ScrollToBottomButton } from '@/components/chat/scroll-to-bottom-button';
import { LeadDetailsSheet } from '@/components/chat/lead-details-sheet';
import type { ReplyTarget } from '@/components/chat/reply-preview';
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

/** Fine-grained stale times: leads=30s, messages=10s. */
const LEAD_STALE = 30_000;
const MESSAGES_STALE = 10_000;

export default function ChatDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const leadId = params.id as string;

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  // Purely-client reactions map (backend not yet supported).
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [newCount, setNewCount] = useState(0);
  // Placeholder — flip when `lead:typing` event wiring lands in the gateway.
  const [isTyping] = useState(false);

  // --- Queries ---
  const { data: currentLead } = useQuery<ChatLead>({
    queryKey: ['lead', leadId],
    queryFn: async () => {
      const res = await api.get(`/api/leads/${leadId}`);
      return res.data;
    },
    enabled: !!leadId,
    staleTime: LEAD_STALE,
  });

  const { data: pipelines = [] } = useQuery<ChatPipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
    staleTime: 5 * 60_000,
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
    isLoading: isMessagesLoading,
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
    staleTime: MESSAGES_STALE,
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
      tempId: _tempId,
    }: {
      content: string;
      isNote: boolean;
      tempId: string;
    }) => {
      if (isNote) {
        const res = await api.post(`/api/leads/${leadId}/messages`, {
          content,
          is_internal_note: true,
        });
        return res.data as ChatMessage;
      }
      const res = await api.post('/api/messages/send-text', {
        lead_id: leadId,
        content,
      });
      return res.data as ChatMessage;
    },
    onMutate: async ({ content, isNote, tempId }) => {
      const tempMessage: ChatMessage = {
        id: tempId,
        lead_id: leadId,
        content,
        type: 'TEXT',
        direction: 'OUTGOING',
        status: 'PENDING',
        is_internal_note: isNote,
        created_at: new Date().toISOString(),
      };
      queryClient.setQueryData<MessagesQueryData>(['messages', leadId], (old) => {
        if (!old || old.pages.length === 0) {
          return {
            pages: [{ messages: [tempMessage] }],
            pageParams: [undefined],
          };
        }
        const pages = [...old.pages];
        const last = { ...pages[pages.length - 1] };
        last.messages = [...last.messages, tempMessage];
        pages[pages.length - 1] = last;
        return { ...old, pages };
      });
      wasAtBottomRef.current = true;
      return { tempId };
    },
    onSuccess: (serverMsg, _vars, ctx) => {
      const tempId = ctx?.tempId;
      queryClient.setQueryData<MessagesQueryData>(['messages', leadId], (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            messages: p.messages.map((m) =>
              m.id === tempId ? { ...serverMsg, status: serverMsg.status ?? 'SENT' } : m,
            ),
          })),
        };
      });
    },
    onError: (err: unknown, _vars, ctx) => {
      const tempId = ctx?.tempId;
      if (tempId) {
        queryClient.setQueryData<MessagesQueryData>(['messages', leadId], (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              messages: p.messages.map((m) =>
                m.id === tempId ? { ...m, status: 'FAILED' as MessageStatus } : m,
              ),
            })),
          };
        });
      }
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
          if (last.messages.some((m) => m.id === data.id)) return old;
          last.messages = [...last.messages, data];
          pages[pages.length - 1] = last;
          return { ...old, pages };
        },
      );
      if (!wasAtBottomRef.current) {
        setNewCount((c) => c + 1);
      }
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

  // --- Smart auto-scroll: only follow if already at bottom ---
  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lastMessageId]);

  // Scroll on conversation change — always jump to bottom instantly.
  useEffect(() => {
    wasAtBottomRef.current = true;
    setShowJumpToBottom(false);
    setNewCount(0);
    setReplyTarget(null);
    const id = window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }, 0);
    return () => window.clearTimeout(id);
  }, [leadId]);

  // --- Infinite scroll up + bottom detection ---
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // Eagerly prefetch next page of history at 80% from top.
    const distanceFromTop = container.scrollTop;
    const threshold = container.clientHeight * 0.2;
    if (distanceFromTop < threshold && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
    // Track "at bottom" with a small slack.
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom < 80;
    wasAtBottomRef.current = atBottom;
    setShowJumpToBottom(!atBottom);
    if (atBottom && newCount > 0) setNewCount(0);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, newCount]);

  const jumpToBottom = useCallback(() => {
    wasAtBottomRef.current = true;
    setNewCount(0);
    setShowJumpToBottom(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // --- Composer handlers ---
  const handleSendText = useCallback(
    (content: string, isNote: boolean) => {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sendTextMutation.mutate({ content, isNote, tempId });
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

  const handleReply = useCallback((msg: ChatMessage) => {
    setReplyTarget({
      id: msg.id,
      author: msg.direction === 'OUTGOING' || msg.direction === 'OUTBOUND'
        ? 'Você'
        : 'Cliente',
      preview: (msg.content ?? '').slice(0, 80) || '[mídia]',
    });
  }, []);

  const handleReact = useCallback((msg: ChatMessage, emoji: string) => {
    setReactions((prev) => {
      const current = prev[msg.id] ?? [];
      if (current.includes(emoji)) return prev;
      return { ...prev, [msg.id]: [...current, emoji] };
    });
  }, []);

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

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <ChatWallpaper>
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            role="log"
            aria-live="polite"
            aria-label="Histórico de mensagens"
            className="h-full overflow-y-auto px-3 py-4 sm:px-6"
          >
            {isFetchingNextPage && (
              <div className="py-2 text-center text-[11px] text-muted-foreground">
                Carregando mensagens anteriores…
              </div>
            )}

            {isMessagesLoading && messages.length === 0 && (
              <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className={
                      i % 2 === 0 ? 'flex justify-start' : 'flex justify-end'
                    }
                  >
                    <Skeleton
                      className={
                        i % 2 === 0
                          ? 'h-12 w-48 rounded-2xl rounded-tl-sm'
                          : 'h-12 w-56 rounded-2xl rounded-tr-sm'
                      }
                    />
                  </div>
                ))}
              </div>
            )}

            {groupedMessages.map((group) => {
              let prevSender: string | null = null;
              let prevTime = 0;
              return (
                <div key={group.key}>
                  <div className="my-4 flex items-center justify-center">
                    <span className="rounded-full border border-border bg-card px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm">
                      {group.label}
                    </span>
                  </div>
                  {group.messages.map((msg) => {
                    const sender = msg.direction;
                    const time = new Date(msg.created_at).getTime();
                    const isFirst =
                      sender !== prevSender || time - prevTime > 60_000;
                    prevSender = sender;
                    prevTime = time;
                    return (
                      <MessageBubble
                        key={msg.id}
                        message={msg}
                        isFirstInGroup={isFirst}
                        onReply={handleReply}
                        onReact={handleReact}
                        reactions={reactions[msg.id]}
                      />
                    );
                  })}
                </div>
              );
            })}

            {isTyping && <TypingIndicator />}

            {messages.length === 0 && !isMessagesLoading && (
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
        </ChatWallpaper>

        <ScrollToBottomButton
          visible={showJumpToBottom}
          unread={newCount}
          onClick={jumpToBottom}
        />
      </div>

      <ChatComposer
        disabled={!currentLead}
        sending={sending}
        conversationKey={leadId}
        replyTarget={replyTarget}
        onCancelReply={() => setReplyTarget(null)}
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
