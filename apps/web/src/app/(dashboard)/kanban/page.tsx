'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import {
  Search,
  X,
  Plus,
  Phone,
  Clock,
  DollarSign,
  MessageCircle,
} from 'lucide-react';
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
  responsavel?: { id: string; nome: string };
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

interface NewLeadForm {
  nome: string;
  telefone: string;
  temperatura: Temperatura;
  valor_estimado: string;
  estagio_id: string;
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

const TEMP_OPTIONS: Temperatura[] = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'];

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

function formatBRL(value?: string): string {
  if (!value) return '';
  return Number(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

// --- Lead Card ---

function LeadCard({
  lead,
  isDragging,
  onClick,
}: {
  lead: Lead;
  isDragging?: boolean;
  onClick: () => void;
}) {
  const tempColor = TEMP_COLORS[lead.temperatura] ?? '#3498DB';

  return (
    <div
      onClick={onClick}
      className="rounded-lg p-3 cursor-pointer transition-all"
      style={{
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-default)',
        borderLeft: `3px solid ${tempColor}`,
        boxShadow: isDragging
          ? '0 8px 24px rgba(0,0,0,0.5)'
          : '0 1px 2px rgba(0,0,0,0.4)',
        opacity: isDragging ? 0.9 : 1,
        transform: isDragging ? 'rotate(2deg) scale(1.02)' : undefined,
      }}
    >
      {/* Name + Temp badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <p
          className="text-sm font-medium truncate"
          style={{ color: 'var(--text-primary)' }}
        >
          {lead.nome}
        </p>
        <span
          className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap"
          style={{
            background: `${tempColor}20`,
            color: tempColor,
          }}
        >
          {TEMP_LABELS[lead.temperatura] ?? lead.temperatura}
        </span>
      </div>

      {/* Phone */}
      <div
        className="flex items-center gap-1.5 mb-1.5 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <Phone size={11} />
        <span>{lead.telefone}</span>
      </div>

      {/* Value */}
      {lead.valor_estimado && (
        <div
          className="flex items-center gap-1.5 mb-1.5 text-xs font-medium"
          style={{ color: 'var(--success)' }}
        >
          <DollarSign size={11} />
          <span>{formatBRL(lead.valor_estimado)}</span>
        </div>
      )}

      {/* Bottom row: time, assignee, unread */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-2">
          {/* Time ago */}
          <span
            className="flex items-center gap-1 text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            <Clock size={10} />
            {timeAgo(lead.ultima_interacao)}
          </span>

          {/* Assignee */}
          {lead.responsavel && (
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center text-white font-bold"
              style={{
                background: 'var(--secondary)',
                fontSize: '8px',
              }}
              title={lead.responsavel.nome}
            >
              {getInitials(lead.responsavel.nome)}
            </span>
          )}
        </div>

        {/* Unread badge */}
        {lead.mensagens_nao_lidas > 0 && (
          <span
            className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-bold"
            style={{ background: 'var(--danger)', color: 'white' }}
          >
            <MessageCircle size={10} />
            {lead.mensagens_nao_lidas}
          </span>
        )}
      </div>
    </div>
  );
}

// --- Sortable Card Wrapper ---

function SortableCard({
  lead,
  onClick,
}: {
  lead: Lead;
  onClick: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: lead.id, data: { type: 'lead', lead } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <LeadCard lead={lead} onClick={onClick} />
    </div>
  );
}

// --- Droppable Column ---

function KanbanColumn({
  stage,
  leads,
  onClickLead,
  onAddLead,
}: {
  stage: Stage;
  leads: Lead[];
  onClickLead: (leadId: string) => void;
  onAddLead: (stageId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${stage.id}`,
    data: { type: 'column', stageId: stage.id },
  });

  return (
    <div className="flex-shrink-0 w-72 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 px-1">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ background: stage.cor }}
        />
        <span
          className="text-sm font-semibold truncate"
          style={{ color: 'var(--text-primary)' }}
        >
          {stage.nome}
        </span>
        <span
          className="text-xs px-1.5 py-0.5 rounded-full"
          style={{
            background: 'var(--bg-surface-3)',
            color: 'var(--text-muted)',
          }}
        >
          {leads.length}
        </span>
        <button
          onClick={() => onAddLead(stage.id)}
          className="ml-auto p-1 rounded-md transition-colors hover:opacity-80"
          style={{ color: 'var(--text-muted)' }}
          title="Adicionar lead"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Cards container */}
      <div
        ref={setNodeRef}
        className="flex-1 space-y-2 overflow-y-auto rounded-lg p-1 min-h-[100px] transition-colors"
        style={{
          background: isOver ? 'rgba(0,168,89,0.05)' : 'transparent',
          border: isOver
            ? '2px dashed var(--primary)'
            : '2px dashed transparent',
        }}
      >
        {leads.map((lead) => (
          <SortableCard
            key={lead.id}
            lead={lead}
            onClick={() => onClickLead(lead.id)}
          />
        ))}

        {leads.length === 0 && (
          <div
            className="rounded-lg p-4 text-center border border-dashed"
            style={{
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-muted)',
            }}
          >
            <p className="text-xs">Sem leads</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Add Lead Modal ---

function AddLeadModal({
  stageId,
  onClose,
  onSubmit,
  isLoading,
}: {
  stageId: string;
  onClose: () => void;
  onSubmit: (data: NewLeadForm) => void;
  isLoading: boolean;
}) {
  const [form, setForm] = useState<NewLeadForm>({
    nome: '',
    telefone: '',
    temperatura: 'FRIO',
    valor_estimado: '',
    estagio_id: stageId,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.nome.trim() || !form.telefone.trim()) {
      toast.error('Nome e telefone sao obrigatorios');
      return;
    }
    onSubmit(form);
  };

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
          <h3
            className="text-sm font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            Novo Lead
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label
              className="text-xs font-medium mb-1 block"
              style={{ color: 'var(--text-secondary)' }}
            >
              Nome *
            </label>
            <input
              style={inputStyle}
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
              placeholder="Nome do lead"
              autoFocus
            />
          </div>

          <div>
            <label
              className="text-xs font-medium mb-1 block"
              style={{ color: 'var(--text-secondary)' }}
            >
              Telefone *
            </label>
            <input
              style={inputStyle}
              value={form.telefone}
              onChange={(e) => setForm({ ...form, telefone: e.target.value })}
              placeholder="+55 31 99999-9999"
            />
          </div>

          <div>
            <label
              className="text-xs font-medium mb-1 block"
              style={{ color: 'var(--text-secondary)' }}
            >
              Temperatura
            </label>
            <select
              style={inputStyle}
              value={form.temperatura}
              onChange={(e) =>
                setForm({ ...form, temperatura: e.target.value as Temperatura })
              }
            >
              {TEMP_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {TEMP_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              className="text-xs font-medium mb-1 block"
              style={{ color: 'var(--text-secondary)' }}
            >
              Valor Estimado
            </label>
            <input
              style={inputStyle}
              type="number"
              step="0.01"
              value={form.valor_estimado}
              onChange={(e) =>
                setForm({ ...form, valor_estimado: e.target.value })
              }
              placeholder="0.00"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: 'var(--bg-surface-3)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-default)',
              }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="flex-1 py-2 rounded-lg text-sm font-medium text-white transition-colors"
              style={{
                background: 'var(--primary)',
                opacity: isLoading ? 0.6 : 1,
              }}
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

export default function KanbanPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [tempFilter, setTempFilter] = useState<Temperatura | ''>('');
  const [activeDragLead, setActiveDragLead] = useState<Lead | null>(null);
  const [addLeadStageId, setAddLeadStageId] = useState<string | null>(null);
  const leadsSnapshotRef = useRef<Lead[] | null>(null);

  // --- Sensors ---
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // --- Queries ---
  const { data: pipelines = [], isLoading: pipelinesLoading } = useQuery<
    Pipeline[]
  >({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
  });

  const stages = useMemo(
    () =>
      (pipelines[0]?.stages ?? []).sort(
        (a: Stage, b: Stage) => a.ordem - b.ordem,
      ),
    [pipelines],
  );

  const { data: leads = [], isLoading: leadsLoading } = useQuery<Lead[]>({
    queryKey: ['leads', searchTerm, tempFilter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (searchTerm) params.search = searchTerm;
      if (tempFilter) params.temperatura = tempFilter;
      const res = await api.get('/api/leads', { params });
      return res.data;
    },
  });

  // --- Mutations ---
  const stageMutation = useMutation({
    mutationFn: async ({
      leadId,
      estagioId,
    }: {
      leadId: string;
      estagioId: string;
    }) => {
      await api.patch(`/api/leads/${leadId}/stage`, {
        estagio_id: estagioId,
      });
    },
    onError: () => {
      // Revert optimistic update
      if (leadsSnapshotRef.current) {
        queryClient.setQueryData(
          ['leads', searchTerm, tempFilter],
          leadsSnapshotRef.current,
        );
        leadsSnapshotRef.current = null;
      }
      toast.error('Erro ao mover lead. Tente novamente.');
    },
    onSuccess: () => {
      leadsSnapshotRef.current = null;
      toast.success('Lead movido com sucesso!');
    },
  });

  const createLeadMutation = useMutation({
    mutationFn: async (data: NewLeadForm) => {
      const body: Record<string, string> = {
        nome: data.nome,
        telefone: data.telefone,
        temperatura: data.temperatura,
        estagio_id: data.estagio_id,
      };
      if (data.valor_estimado) body.valor_estimado = data.valor_estimado;
      const res = await api.post('/api/leads', body);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setAddLeadStageId(null);
      toast.success('Lead criado!');
    },
    onError: () => {
      toast.error('Erro ao criar lead.');
    },
  });

  // --- Socket.IO ---
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) return;

    const handleStageChanged = (data: {
      leadId: string;
      estagio_id: string;
    }) => {
      queryClient.setQueryData<Lead[]>(
        ['leads', searchTerm, tempFilter],
        (old) =>
          old?.map((l) =>
            l.id === data.leadId
              ? { ...l, estagio_id: data.estagio_id }
              : l,
          ),
      );
    };

    const handleNewMessage = (data: { leadId: string }) => {
      queryClient.setQueryData<Lead[]>(
        ['leads', searchTerm, tempFilter],
        (old) =>
          old?.map((l) =>
            l.id === data.leadId
              ? { ...l, mensagens_nao_lidas: l.mensagens_nao_lidas + 1 }
              : l,
          ),
      );
    };

    socket.on('lead:stage-changed', handleStageChanged);
    socket.on('lead:new-message', handleNewMessage);

    return () => {
      socket.off('lead:stage-changed', handleStageChanged);
      socket.off('lead:new-message', handleNewMessage);
    };
  }, [queryClient, searchTerm, tempFilter]);

  // --- DnD Handlers ---
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const lead = leads.find((l) => l.id === event.active.id);
      if (lead) setActiveDragLead(lead);
    },
    [leads],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragLead(null);
      const { active, over } = event;
      if (!over) return;

      const leadId = active.id as string;
      const lead = leads.find((l) => l.id === leadId);
      if (!lead) return;

      let targetStageId: string | null = null;

      // Check if dropped over a column
      const overId = over.id as string;
      if (overId.startsWith('column-')) {
        targetStageId = overId.replace('column-', '');
      } else {
        // Dropped on another lead card — find its stage
        const overLead = leads.find((l) => l.id === overId);
        if (overLead) targetStageId = overLead.estagio_id;
      }

      if (!targetStageId || targetStageId === lead.estagio_id) return;

      // Optimistic update
      leadsSnapshotRef.current = [...leads];
      queryClient.setQueryData<Lead[]>(
        ['leads', searchTerm, tempFilter],
        (old) =>
          old?.map((l) =>
            l.id === leadId ? { ...l, estagio_id: targetStageId } : l,
          ),
      );

      stageMutation.mutate({ leadId, estagioId: targetStageId });
    },
    [leads, queryClient, searchTerm, tempFilter, stageMutation],
  );

  // --- Computed ---
  const leadsByStage = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    for (const stage of stages) {
      map[stage.id] = [];
    }
    for (const lead of leads) {
      if (map[lead.estagio_id]) {
        map[lead.estagio_id].push(lead);
      }
    }
    return map;
  }, [leads, stages]);

  // --- Loading ---
  if (pipelinesLoading || leadsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Carregando Kanban...
        </div>
      </div>
    );
  }

  if (stages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Nenhum pipeline configurado.
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Configure um pipeline nas configuracoes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filters Bar */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        {/* Search */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 max-w-xs"
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-default)',
          }}
        >
          <Search size={14} style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Buscar lead..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="bg-transparent text-sm outline-none flex-1"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>

        {/* Temperature filter */}
        <select
          value={tempFilter}
          onChange={(e) => setTempFilter(e.target.value as Temperatura | '')}
          className="text-sm rounded-lg px-3 py-1.5 outline-none"
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        >
          <option value="">Todas temperaturas</option>
          {TEMP_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {TEMP_LABELS[t]}
            </option>
          ))}
        </select>

        {/* Clear */}
        {(searchTerm || tempFilter) && (
          <button
            onClick={() => {
              setSearchTerm('');
              setTempFilter('');
            }}
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg transition-colors hover:opacity-80"
            style={{
              background: 'var(--bg-surface-3)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-default)',
            }}
          >
            <X size={12} />
            Limpar filtros
          </button>
        )}
      </div>

      {/* Kanban Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 p-4 h-full min-w-max">
            {stages.map((stage) => (
              <KanbanColumn
                key={stage.id}
                stage={stage}
                leads={leadsByStage[stage.id] ?? []}
                onClickLead={(leadId) => router.push(`/chat/${leadId}`)}
                onAddLead={(stageId) => setAddLeadStageId(stageId)}
              />
            ))}
          </div>

          {/* Drag Overlay */}
          <DragOverlay>
            {activeDragLead ? (
              <div style={{ width: 280 }}>
                <LeadCard
                  lead={activeDragLead}
                  isDragging
                  onClick={() => {}}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Add Lead Modal */}
      {addLeadStageId && (
        <AddLeadModal
          stageId={addLeadStageId}
          onClose={() => setAddLeadStageId(null)}
          onSubmit={(data) => createLeadMutation.mutate(data)}
          isLoading={createLeadMutation.isPending}
        />
      )}
    </div>
  );
}
