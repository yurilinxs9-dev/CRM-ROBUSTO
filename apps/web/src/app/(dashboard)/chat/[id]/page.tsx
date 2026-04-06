'use client';

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type FormEvent,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from '@tanstack/react-query';
import {
  Search,
  Send,
  Phone,
  StickyNote,
  ChevronDown,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  ArrowLeft,
  MessageCircle,
  Plus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getSocket, joinLead, leaveLead } from '@/lib/socket';

// --- Types ---

type Temperatura = 'FRIO' | 'MORNO' | 'QUENTE' | 'MUITO_QUENTE';
type MessageDirection = 'INBOUND' | 'OUTBOUND';
type MessageStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'PENDING';

interface Lead {
  id: string;
  nome: string;
  telefone: string;
  temperatura: Temperatura;
  estagio_id: string;
  mensagens_nao_lidas: number;
  valor_estimado?: string;
  ultima_interacao?: string;
  responsavel?: { id: string; nome: string };
}

interface Message {
  id: string;
  whatsapp_message_id?: string;
  content: string;
  type: string;
  direction: MessageDirection;
  status: MessageStatus;
  is_internal_note: boolean;
  media_url?: string;
  created_at: string;
  lead_id: string;
}

interface Stage {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
}

interface Pipeline {
  id: string;
  nome: string;
  stages: Stage[];
}

interface MessagesResponse {
  messages: Message[];
  nextCursor?: string;
}

// --- Constants ---

const TEMP_COLORS: Record<Temperatura, string> = {
  FRIO: '#38bdf8',
  MORNO: '#fb923c',
  QUENTE: '#f97316',
  MUITO_QUENTE: '#ef4444',
};

const TEMP_LABELS: Record<Temperatura, string> = {
  FRIO: 'Frio',
  MORNO: 'Morno',
  QUENTE: 'Quente',
  MUITO_QUENTE: 'Muito Quente',
};

// --- Helpers ---

function timeAgo(date?: string): string {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function formatDateSeparator(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) return 'Hoje';
  if (diffDays === 1) return 'Ontem';

  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function getDateKey(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('pt-BR');
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --- Status Icon ---

function StatusIcon({ status }: { status: MessageStatus }) {
  switch (status) {
    case 'PENDING':
      return <Clock size={12} style={{ color: 'var(--text-muted)' }} />;
    case 'SENT':
      return <Check size={12} style={{ color: 'var(--text-muted)' }} />;
    case 'DELIVERED':
      return <CheckCheck size={12} style={{ color: 'var(--text-muted)' }} />;
    case 'READ':
      return <CheckCheck size={12} style={{ color: '#38bdf8' }} />;
    case 'FAILED':
      return <AlertCircle size={12} style={{ color: 'var(--danger)' }} />;
    default:
      return null;
  }
}

// --- Audio Player (simple waveform placeholder using wavesurfer) ---

function AudioPlayer({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<ReturnType<typeof import('wavesurfer.js')['default']['create']> | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState('0:00');
  const [currentTime, setCurrentTime] = useState('0:00');

  useEffect(() => {
    let ws: ReturnType<typeof import('wavesurfer.js')['default']['create']> | null = null;

    const loadWavesurfer = async () => {
      if (!containerRef.current) return;
      const WaveSurfer = (await import('wavesurfer.js')).default;
      ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: 'var(--text-muted)',
        progressColor: 'var(--primary)',
        cursorColor: 'transparent',
        height: 32,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
      });

      ws.on('ready', () => {
        const dur = ws?.getDuration() ?? 0;
        const m = Math.floor(dur / 60);
        const s = Math.floor(dur % 60);
        setDuration(`${m}:${s.toString().padStart(2, '0')}`);
      });

      ws.on('audioprocess', () => {
        const cur = ws?.getCurrentTime() ?? 0;
        const m = Math.floor(cur / 60);
        const s = Math.floor(cur % 60);
        setCurrentTime(`${m}:${s.toString().padStart(2, '0')}`);
      });

      ws.on('play', () => setIsPlaying(true));
      ws.on('pause', () => setIsPlaying(false));
      ws.on('finish', () => setIsPlaying(false));

      ws.load(url);
      wavesurferRef.current = ws;
    };

    loadWavesurfer();

    return () => {
      ws?.destroy();
    };
  }, [url]);

  return (
    <div className="flex items-center gap-2" style={{ minWidth: 200 }}>
      <button
        onClick={() => wavesurferRef.current?.playPause()}
        className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
        style={{ background: 'var(--primary)', color: 'white' }}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>
      <div className="flex-1">
        <div ref={containerRef} />
        <div className="flex justify-between mt-0.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {currentTime}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {duration}
          </span>
        </div>
      </div>
    </div>
  );
}

// --- Message Bubble ---

function MessageBubble({ message }: { message: Message }) {
  const isOutbound = message.direction === 'OUTBOUND';
  const isNote = message.is_internal_note;
  const isAudio = message.type === 'audio' && message.media_url;

  if (isNote) {
    return (
      <div className="flex justify-center my-1">
        <div
          className="rounded-lg px-4 py-2 max-w-lg w-full"
          style={{
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
          }}
        >
          <div className="flex items-start gap-2">
            <StickyNote
              size={14}
              className="mt-0.5 flex-shrink-0"
              style={{ color: '#f59e0b' }}
            />
            <div>
              <p
                className="text-xs font-medium mb-0.5"
                style={{ color: '#f59e0b' }}
              >
                Nota Interna
              </p>
              <p
                className="text-sm italic"
                style={{ color: 'var(--text-secondary)' }}
              >
                {message.content}
              </p>
              <p
                className="text-xs mt-1 text-right"
                style={{ color: 'var(--text-muted)' }}
              >
                {formatTime(message.created_at)}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex ${isOutbound ? 'justify-end' : 'justify-start'} my-0.5`}
    >
      <div
        className="rounded-lg px-3 py-2 max-w-md"
        style={
          isOutbound
            ? {
                background: 'rgba(0, 168, 89, 0.12)',
                border: '1px solid rgba(0, 168, 89, 0.25)',
                borderRadius: '12px 12px 4px 12px',
              }
            : {
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-default)',
                borderRadius: '12px 12px 12px 4px',
              }
        }
      >
        {isAudio ? (
          <AudioPlayer url={message.media_url!} />
        ) : (
          <p
            className="text-sm whitespace-pre-wrap break-words"
            style={{ color: 'var(--text-primary)' }}
          >
            {message.content}
          </p>
        )}

        <div
          className={`flex items-center gap-1 mt-1 ${
            isOutbound ? 'justify-end' : 'justify-start'
          }`}
        >
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {formatTime(message.created_at)}
          </span>
          {isOutbound && <StatusIcon status={message.status} />}
        </div>
      </div>
    </div>
  );
}

// --- Sidebar Lead Item ---

function SidebarLeadItem({
  lead,
  isActive,
  onClick,
}: {
  lead: Lead;
  isActive: boolean;
  onClick: () => void;
}) {
  const tempColor = TEMP_COLORS[lead.temperatura] ?? '#3498DB';

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors"
      style={{
        background: isActive ? 'var(--bg-surface-3)' : 'transparent',
        borderLeft: isActive ? `2px solid var(--primary)` : '2px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-surface-2)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
        style={{
          background: `${tempColor}60`,
          fontSize: '10px',
        }}
      >
        {getInitials(lead.nome)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1">
          <span
            className="text-xs font-medium truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {lead.nome}
          </span>
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: tempColor }}
          />
        </div>
        <span
          className="text-xs truncate block"
          style={{ color: 'var(--text-muted)', fontSize: '10px' }}
        >
          {lead.telefone}
        </span>
      </div>
      {lead.mensagens_nao_lidas > 0 && (
        <span
          className="text-xs px-1 py-0.5 rounded-full font-bold flex-shrink-0"
          style={{
            background: 'var(--danger)',
            color: 'white',
            fontSize: '9px',
            minWidth: '16px',
            textAlign: 'center',
          }}
        >
          {lead.mensagens_nao_lidas}
        </span>
      )}
    </button>
  );
}

// --- Main Page ---

export default function ChatDetailPage() {
  const params = useParams();
  const leadId = params.id as string;
  const router = useRouter();
  const queryClient = useQueryClient();

  const [messageText, setMessageText] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [showStageDropdown, setShowStageDropdown] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // --- Queries ---

  const { data: leads = [] } = useQuery<Lead[]>({
    queryKey: ['leads', sidebarSearch],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (sidebarSearch) params.search = sidebarSearch;
      const res = await api.get('/api/leads', { params });
      return res.data;
    },
  });

  const { data: currentLead } = useQuery<Lead>({
    queryKey: ['lead', leadId],
    queryFn: async () => {
      const res = await api.get(`/api/leads/${leadId}`);
      return res.data;
    },
    enabled: !!leadId,
  });

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
  });

  const stages = useMemo(
    () => (pipelines[0]?.stages ?? []).sort((a, b) => a.ordem - b.ordem),
    [pipelines],
  );

  const currentStage = stages.find((s) => s.id === currentLead?.estagio_id);

  const {
    data: messagesData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<MessagesResponse>({
    queryKey: ['messages', leadId],
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = { limit: '30' };
      if (pageParam) params.cursor = pageParam as string;
      const res = await api.get(`/api/leads/${leadId}/messages`, { params });
      return res.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!leadId,
  });

  const messages = useMemo(() => {
    if (!messagesData?.pages) return [];
    const allMessages: Message[] = [];
    // Pages come newest-first from cursor, so reverse
    for (let i = messagesData.pages.length - 1; i >= 0; i--) {
      allMessages.push(...(messagesData.pages[i].messages ?? []));
    }
    // Sort by created_at ascending
    allMessages.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return allMessages;
  }, [messagesData]);

  // --- Mutations ---

  const sendMessageMutation = useMutation({
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
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        (err as { message?: string })?.message ??
        'Erro ao enviar mensagem.';
      toast.error(msg);
    },
  });

  const moveStageMutation = useMutation({
    mutationFn: async (estagioId: string) => {
      await api.patch(`/api/leads/${leadId}/stage`, {
        estagio_id: estagioId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setShowStageDropdown(false);
      toast.success('Etapa atualizada!');
    },
    onError: () => {
      toast.error('Erro ao mover etapa.');
    },
  });

  // --- Socket.IO ---

  useEffect(() => {
    if (!leadId) return;
    joinLead(leadId);

    const socket = getSocket();

    const handleNewMessage = (data: Message) => {
      if (data.lead_id === leadId) {
        queryClient.setQueryData<{ pages: MessagesResponse[]; pageParams: (string | undefined)[] }>(
          ['messages', leadId],
          (old) => {
            if (!old) return old;
            const lastPageIndex = old.pages.length - 1;
            const updatedPages = [...old.pages];
            updatedPages[lastPageIndex] = {
              ...updatedPages[lastPageIndex],
              messages: [...updatedPages[lastPageIndex].messages, data],
            };
            return { ...old, pages: updatedPages };
          },
        );
      }
    };

    const handleStatusUpdate = (data: {
      messageId: string;
      status: MessageStatus;
    }) => {
      queryClient.setQueryData<{ pages: MessagesResponse[]; pageParams: (string | undefined)[] }>(
        ['messages', leadId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m) =>
                m.id === data.messageId ? { ...m, status: data.status } : m,
              ),
            })),
          };
        },
      );
    };

    socket.on('message:new', handleNewMessage);
    socket.on('message:status-updated', handleStatusUpdate);

    return () => {
      leaveLead(leadId);
      socket.off('message:new', handleNewMessage);
      socket.off('message:status-updated', handleStatusUpdate);
    };
  }, [leadId, queryClient]);

  // --- Auto-scroll ---

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // --- Infinite scroll (load older messages) ---

  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (container.scrollTop < 100 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // --- Send message ---

  const handleSend = useCallback(() => {
    const content = messageText.trim();
    if (!content) return;
    sendMessageMutation.mutate({ content, isNote: isInternalNote });
    setMessageText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [messageText, isInternalNote, sendMessageMutation]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // --- Auto-resize textarea ---
  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMessageText(e.target.value);
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    },
    [],
  );

  // --- Group messages by date ---
  const groupedMessages = useMemo(() => {
    const groups: { date: string; label: string; messages: Message[] }[] = [];
    let currentDate = '';

    for (const msg of messages) {
      const dateKey = getDateKey(msg.created_at);
      if (dateKey !== currentDate) {
        currentDate = dateKey;
        groups.push({
          date: dateKey,
          label: formatDateSeparator(msg.created_at),
          messages: [msg],
        });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [messages]);

  // Sort sidebar leads
  const sortedLeads = [...leads].sort((a, b) => {
    if (b.mensagens_nao_lidas !== a.mensagens_nao_lidas) {
      return b.mensagens_nao_lidas - a.mensagens_nao_lidas;
    }
    const dateA = a.ultima_interacao ? new Date(a.ultima_interacao).getTime() : 0;
    const dateB = b.ultima_interacao ? new Date(b.ultima_interacao).getTime() : 0;
    return dateB - dateA;
  });

  const tempColor = currentLead
    ? TEMP_COLORS[currentLead.temperatura] ?? '#3498DB'
    : '#3498DB';

  return (
    <div className="flex h-full">
      {/* Left sidebar - conversation list */}
      <div
        className="flex flex-col flex-shrink-0 border-r"
        style={{
          width: 240,
          background: 'var(--bg-surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        {/* Sidebar search */}
        <div
          className="p-2 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-md"
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-default)',
            }}
          >
            <Search size={12} style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Buscar..."
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              className="bg-transparent text-xs outline-none flex-1"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        {/* Sidebar leads list */}
        <div className="flex-1 overflow-y-auto">
          {sortedLeads.map((lead) => (
            <SidebarLeadItem
              key={lead.id}
              lead={lead}
              isActive={lead.id === leadId}
              onClick={() => router.push(`/chat/${lead.id}`)}
            />
          ))}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        {currentLead && (
          <div
            className="flex items-center gap-3 px-4 py-2.5 border-b flex-shrink-0"
            style={{
              background: 'var(--bg-surface-1)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            {/* Back button (mobile-friendly) */}
            <button
              onClick={() => router.push('/chat')}
              className="p-1 rounded-md lg:hidden"
              style={{ color: 'var(--text-secondary)' }}
            >
              <ArrowLeft size={18} />
            </button>

            {/* Lead avatar */}
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-xs flex-shrink-0"
              style={{
                background: `${tempColor}60`,
                border: `2px solid ${tempColor}`,
              }}
            >
              {getInitials(currentLead.nome)}
            </div>

            {/* Lead info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className="text-sm font-medium truncate"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {currentLead.nome}
                </span>
                <span
                  className="text-xs px-1.5 py-0.5 rounded-full"
                  style={{
                    background: `${tempColor}20`,
                    color: tempColor,
                  }}
                >
                  {TEMP_LABELS[currentLead.temperatura]}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="text-xs flex items-center gap-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Phone size={10} />
                  {currentLead.telefone}
                </span>
              </div>
            </div>

            {/* Move stage dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowStageDropdown(!showStageDropdown)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: currentStage
                    ? `${currentStage.cor}20`
                    : 'var(--bg-surface-3)',
                  color: currentStage?.cor ?? 'var(--text-secondary)',
                  border: `1px solid ${currentStage?.cor ?? 'var(--border-default)'}40`,
                }}
              >
                {currentStage && (
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: currentStage.cor }}
                  />
                )}
                {currentStage?.nome ?? 'Mover etapa'}
                <ChevronDown size={12} />
              </button>

              {showStageDropdown && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowStageDropdown(false)}
                  />
                  <div
                    className="absolute right-0 top-full mt-1 z-50 rounded-lg overflow-hidden min-w-[180px]"
                    style={{
                      background: 'var(--bg-surface-2)',
                      border: '1px solid var(--border-default)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                    }}
                  >
                    {stages.map((stage) => (
                      <button
                        key={stage.id}
                        onClick={() => moveStageMutation.mutate(stage.id)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors"
                        style={{
                          color:
                            stage.id === currentLead.estagio_id
                              ? stage.cor
                              : 'var(--text-secondary)',
                          background:
                            stage.id === currentLead.estagio_id
                              ? `${stage.cor}15`
                              : 'transparent',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.background =
                            'var(--bg-surface-3)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.background =
                            stage.id === currentLead.estagio_id
                              ? `${stage.cor}15`
                              : 'transparent';
                        }}
                      >
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ background: stage.cor }}
                        />
                        {stage.nome}
                        {stage.id === currentLead.estagio_id && (
                          <Check size={12} className="ml-auto" />
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Messages area */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-4 py-3"
          onScroll={handleScroll}
          style={{ background: 'var(--bg-base)' }}
        >
          {/* Load more */}
          {isFetchingNextPage && (
            <div className="text-center py-2">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Carregando mensagens anteriores...
              </span>
            </div>
          )}

          {hasNextPage && !isFetchingNextPage && (
            <div className="text-center py-2">
              <button
                onClick={() => fetchNextPage()}
                className="text-xs px-3 py-1 rounded-md transition-colors"
                style={{
                  background: 'var(--bg-surface-2)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-default)',
                }}
              >
                Carregar anteriores
              </button>
            </div>
          )}

          {/* Grouped messages */}
          {groupedMessages.map((group) => (
            <div key={group.date}>
              {/* Date separator */}
              <div className="flex items-center gap-3 my-4">
                <div
                  className="flex-1 h-px"
                  style={{ background: 'var(--border-subtle)' }}
                />
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{
                    background: 'var(--bg-surface-2)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {group.label}
                </span>
                <div
                  className="flex-1 h-px"
                  style={{ background: 'var(--border-subtle)' }}
                />
              </div>

              {/* Messages */}
              {group.messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
            </div>
          ))}

          {messages.length === 0 && !isFetchingNextPage && (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <MessageCircle
                size={40}
                style={{ color: 'var(--text-muted)' }}
              />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Nenhuma mensagem ainda
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Envie a primeira mensagem para iniciar a conversa
              </p>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div
          className="border-t flex-shrink-0"
          style={{
            borderColor: isInternalNote
              ? 'rgba(245, 158, 11, 0.3)'
              : 'var(--border-subtle)',
            background: isInternalNote
              ? 'rgba(245, 158, 11, 0.05)'
              : 'var(--bg-surface-1)',
          }}
        >
          {/* Internal note toggle bar */}
          {isInternalNote && (
            <div
              className="flex items-center gap-2 px-4 py-1.5 text-xs"
              style={{ color: '#f59e0b' }}
            >
              <StickyNote size={12} />
              <span className="font-medium">Modo Nota Interna</span>
              <span style={{ color: 'var(--text-muted)' }}>
                - Esta mensagem nao sera enviada ao cliente
              </span>
            </div>
          )}

          <div className="flex items-end gap-2 px-4 py-3">
            {/* Internal note toggle */}
            <button
              onClick={() => setIsInternalNote(!isInternalNote)}
              className="p-2 rounded-lg flex-shrink-0 transition-colors"
              style={{
                background: isInternalNote
                  ? 'rgba(245, 158, 11, 0.15)'
                  : 'var(--bg-surface-2)',
                color: isInternalNote ? '#f59e0b' : 'var(--text-muted)',
                border: isInternalNote
                  ? '1px solid rgba(245, 158, 11, 0.3)'
                  : '1px solid var(--border-default)',
              }}
              title={
                isInternalNote
                  ? 'Voltar para mensagem normal'
                  : 'Escrever nota interna'
              }
            >
              <StickyNote size={16} />
            </button>

            {/* Text input */}
            <div
              className="flex-1 rounded-lg overflow-hidden"
              style={{
                background: isInternalNote
                  ? 'rgba(245, 158, 11, 0.08)'
                  : 'var(--bg-surface-2)',
                border: isInternalNote
                  ? '1px solid rgba(245, 158, 11, 0.25)'
                  : '1px solid var(--border-default)',
              }}
            >
              <textarea
                ref={textareaRef}
                value={messageText}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder={
                  isInternalNote
                    ? 'Escreva uma nota interna...'
                    : 'Digite uma mensagem...'
                }
                rows={1}
                className="w-full bg-transparent text-sm px-3 py-2 outline-none resize-none"
                style={{
                  color: 'var(--text-primary)',
                  maxHeight: 120,
                  fontStyle: isInternalNote ? 'italic' : 'normal',
                }}
              />
            </div>

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!messageText.trim() || sendMessageMutation.isPending}
              className="p-2 rounded-lg flex-shrink-0 transition-colors"
              style={{
                background: messageText.trim()
                  ? isInternalNote
                    ? '#f59e0b'
                    : 'var(--primary)'
                  : 'var(--bg-surface-3)',
                color: messageText.trim() ? 'white' : 'var(--text-muted)',
                opacity: sendMessageMutation.isPending ? 0.6 : 1,
              }}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
