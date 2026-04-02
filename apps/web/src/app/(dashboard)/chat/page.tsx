'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, X, MessageCircle, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

// --- Types ---

type Temperatura = 'FRIO' | 'MORNO' | 'QUENTE' | 'MUITO_QUENTE';

interface Lead {
  id: string;
  nome: string;
  telefone: string;
  temperatura: Temperatura;
  estagio_id: string;
  mensagens_nao_lidas: number;
  valor_estimado?: string;
  ultima_interacao?: string;
  ultimo_mensagem?: string;
  responsavel?: { id: string; nome: string };
}

// --- Constants ---

const TEMP_COLORS: Record<Temperatura, string> = {
  FRIO: '#38bdf8',
  MORNO: '#fb923c',
  QUENTE: '#f97316',
  MUITO_QUENTE: '#ef4444',
};

const TEMP_OPTIONS: Temperatura[] = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'];
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
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}sem`;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

// --- New Lead Modal ---

function NewLeadModal({
  onClose,
  onSubmit,
  isLoading,
}: {
  onClose: () => void;
  onSubmit: (data: { nome: string; telefone: string; temperatura: Temperatura }) => void;
  isLoading: boolean;
}) {
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [temperatura, setTemperatura] = useState<Temperatura>('FRIO');

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-surface-1)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    borderRadius: 'var(--radius)',
    padding: '8px 12px',
    fontSize: '13px',
    width: '100%',
    outline: 'none',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl p-5 w-96"
        style={{
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-default)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Novo Lead
          </h3>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!nome.trim() || !telefone.trim()) {
              toast.error('Nome e telefone sao obrigatorios');
              return;
            }
            onSubmit({ nome, telefone, temperatura });
          }}
          className="space-y-3"
        >
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
              Nome *
            </label>
            <input style={inputStyle} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome do lead" autoFocus />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
              Telefone *
            </label>
            <input style={inputStyle} value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="+55 31 99999-9999" />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
              Temperatura
            </label>
            <select style={inputStyle} value={temperatura} onChange={(e) => setTemperatura(e.target.value as Temperatura)}>
              {TEMP_OPTIONS.map((t) => (
                <option key={t} value={t}>{TEMP_LABELS[t]}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="flex-1 py-2 rounded-lg text-sm font-medium text-white"
              style={{ background: 'var(--primary)', opacity: isLoading ? 0.6 : 1 }}
            >
              {isLoading ? 'Criando...' : 'Criar Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Main Page ---

export default function ChatPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showNewLead, setShowNewLead] = useState(false);

  const { data: leads = [], isLoading } = useQuery<Lead[]>({
    queryKey: ['leads', search],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (search) params.search = search;
      const res = await api.get('/api/leads', { params });
      return res.data;
    },
  });

  const createLeadMutation = useMutation({
    mutationFn: async (data: { nome: string; telefone: string; temperatura: Temperatura }) => {
      const res = await api.post('/api/leads', data);
      return res.data;
    },
    onSuccess: (data: Lead) => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setShowNewLead(false);
      toast.success('Lead criado!');
      router.push(`/chat/${data.id}`);
    },
    onError: () => {
      toast.error('Erro ao criar lead.');
    },
  });

  // Socket: listen for new messages to update list
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) return;

    const handleNewMessage = (data: { lead_id: string }) => {
      queryClient.setQueryData<Lead[]>(['leads', search], (old) =>
        old?.map((l) =>
          l.id === data.lead_id
            ? { ...l, mensagens_nao_lidas: l.mensagens_nao_lidas + 1 }
            : l,
        ),
      );
    };

    socket.on('new_message', handleNewMessage);
    return () => {
      socket.off('new_message', handleNewMessage);
    };
  }, [queryClient, search]);

  // Sort: most recent interaction first, then unread count
  const sortedLeads = [...leads].sort((a, b) => {
    if (b.mensagens_nao_lidas !== a.mensagens_nao_lidas) {
      return b.mensagens_nao_lidas - a.mensagens_nao_lidas;
    }
    const dateA = a.ultima_interacao ? new Date(a.ultima_interacao).getTime() : 0;
    const dateB = b.ultima_interacao ? new Date(b.ultima_interacao).getTime() : 0;
    return dateB - dateA;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        {/* Search */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1"
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-default)',
          }}
        >
          <Search size={14} style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Buscar conversa..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-sm outline-none flex-1"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>

        <button
          onClick={() => setShowNewLead(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90"
          style={{ background: 'var(--primary)' }}
        >
          <Plus size={14} />
          Novo Lead
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Carregando...
            </span>
          </div>
        )}

        {!isLoading && sortedLeads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <MessageCircle size={32} style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Nenhuma conversa encontrada
            </p>
          </div>
        )}

        {sortedLeads.map((lead) => {
          const tempColor = TEMP_COLORS[lead.temperatura] ?? '#3498DB';
          return (
            <button
              key={lead.id}
              onClick={() => router.push(`/chat/${lead.id}`)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:opacity-90"
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                background: 'transparent',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-surface-2)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              {/* Avatar */}
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-xs flex-shrink-0"
                style={{
                  background: `linear-gradient(135deg, ${tempColor}40, ${tempColor}80)`,
                  border: `2px solid ${tempColor}`,
                }}
              >
                {getInitials(lead.nome)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-sm font-medium truncate"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {lead.nome}
                  </span>
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {timeAgo(lead.ultima_interacao)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Phone size={10} style={{ color: 'var(--text-muted)' }} className="flex-shrink-0" />
                    <span
                      className="text-xs truncate"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {lead.telefone}
                    </span>
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: tempColor }}
                    />
                  </div>
                  {lead.mensagens_nao_lidas > 0 && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded-full font-bold flex-shrink-0"
                      style={{ background: 'var(--danger)', color: 'white', fontSize: '10px' }}
                    >
                      {lead.mensagens_nao_lidas}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* New Lead Modal */}
      {showNewLead && (
        <NewLeadModal
          onClose={() => setShowNewLead(false)}
          onSubmit={(data) => createLeadMutation.mutate(data)}
          isLoading={createLeadMutation.isPending}
        />
      )}
    </div>
  );
}
