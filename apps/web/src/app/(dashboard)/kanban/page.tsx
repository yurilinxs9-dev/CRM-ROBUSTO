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
import { Search, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

import { LeadCard, type Lead, type Temperatura, TEMP_LABELS } from '@/components/kanban/lead-card';
import { StageColumn, type Stage } from '@/components/kanban/stage-column';
import {
  NewLeadDialog,
  type NewLeadFormData,
} from '@/components/kanban/new-lead-dialog';

interface Pipeline {
  id: string;
  nome: string;
  stages: Stage[];
}

const TEMP_OPTIONS: Temperatura[] = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'];

export default function KanbanPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [tempFilter, setTempFilter] = useState<Temperatura | 'ALL'>('ALL');
  const [responsavelFilter, setResponsavelFilter] = useState<string>('ALL');
  const [activeDragLead, setActiveDragLead] = useState<Lead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultStageId, setDefaultStageId] = useState<string | null>(null);
  const leadsSnapshotRef = useRef<Lead[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // --- Pipelines ---
  const { data: pipelines = [], isLoading: pipelinesLoading } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
  });

  useEffect(() => {
    if (!activePipelineId && pipelines.length > 0) {
      setActivePipelineId(pipelines[0].id);
    }
  }, [pipelines, activePipelineId]);

  const activePipeline = useMemo(
    () => pipelines.find((p) => p.id === activePipelineId) ?? pipelines[0],
    [pipelines, activePipelineId]
  );

  const stages = useMemo<Stage[]>(
    () => [...(activePipeline?.stages ?? [])].sort((a, b) => a.ordem - b.ordem),
    [activePipeline]
  );

  // --- Leads ---
  const leadsQueryKey = useMemo(() => ['leads', activePipelineId] as const, [activePipelineId]);

  const { data: leads = [], isLoading: leadsLoading } = useQuery<Lead[]>({
    queryKey: leadsQueryKey,
    queryFn: async () => {
      if (!activePipelineId) return [];
      const res = await api.get('/api/leads', { params: { pipeline_id: activePipelineId } });
      return res.data;
    },
    enabled: !!activePipelineId,
  });

  // --- Filtered leads ---
  const filteredLeads = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return leads.filter((l) => {
      if (tempFilter !== 'ALL' && l.temperatura !== tempFilter) return false;
      if (responsavelFilter !== 'ALL' && l.responsavel?.id !== responsavelFilter) return false;
      if (term) {
        const haystack = `${l.nome} ${l.telefone}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [leads, searchTerm, tempFilter, responsavelFilter]);

  const responsaveis = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of leads) {
      if (l.responsavel) map.set(l.responsavel.id, l.responsavel.nome);
    }
    return Array.from(map.entries());
  }, [leads]);

  // --- Mutations ---
  const stageMutation = useMutation({
    mutationFn: async ({ leadId, estagioId }: { leadId: string; estagioId: string }) => {
      await api.patch(`/api/leads/${leadId}/stage`, { estagio_id: estagioId });
    },
    onError: () => {
      if (leadsSnapshotRef.current) {
        queryClient.setQueryData(leadsQueryKey, leadsSnapshotRef.current);
        leadsSnapshotRef.current = null;
      }
      toast.error('Erro ao mover lead. Tente novamente.');
    },
    onSuccess: () => {
      leadsSnapshotRef.current = null;
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });

  const createLeadMutation = useMutation({
    mutationFn: async (data: NewLeadFormData) => {
      const body: Record<string, string> = {
        nome: data.nome,
        telefone: data.telefone,
        temperatura: data.temperatura,
        estagio_id: data.estagio_id,
      };
      if (data.email) body.email = data.email;
      const res = await api.post('/api/leads', body);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setDialogOpen(false);
      toast.success('Lead criado com sucesso!');
    },
    onError: () => {
      toast.error('Erro ao criar lead.');
    },
  });

  // --- Socket ---
  useEffect(() => {
    const socket = getSocket();

    const handleStageChanged = () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    };

    const handleNewMessage = (data: { leadId: string; message?: { conteudo?: string } }) => {
      queryClient.setQueryData<Lead[]>(leadsQueryKey, (old) =>
        old?.map((l) =>
          l.id === data.leadId
            ? {
                ...l,
                mensagens_nao_lidas: l.mensagens_nao_lidas + 1,
                ultima_mensagem_preview: data.message?.conteudo ?? l.ultima_mensagem_preview,
                ultima_interacao: new Date().toISOString(),
              }
            : l
        )
      );
    };

    socket.on('lead:stage-changed', handleStageChanged);
    socket.on('lead:new-message', handleNewMessage);
    return () => {
      socket.off('lead:stage-changed', handleStageChanged);
      socket.off('lead:new-message', handleNewMessage);
    };
  }, [queryClient, leadsQueryKey]);

  // --- DnD ---
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const lead = leads.find((l) => l.id === event.active.id);
      if (lead) setActiveDragLead(lead);
    },
    [leads]
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
      const overId = over.id as string;
      if (overId.startsWith('column-')) {
        targetStageId = overId.replace('column-', '');
      } else {
        const overLead = leads.find((l) => l.id === overId);
        if (overLead) targetStageId = overLead.estagio_id;
      }

      if (!targetStageId || targetStageId === lead.estagio_id) return;

      // Optimistic update
      leadsSnapshotRef.current = leads;
      const finalTarget = targetStageId;
      queryClient.setQueryData<Lead[]>(leadsQueryKey, (old) =>
        old?.map((l) => (l.id === leadId ? { ...l, estagio_id: finalTarget } : l))
      );
      stageMutation.mutate({ leadId, estagioId: finalTarget });
    },
    [leads, queryClient, leadsQueryKey, stageMutation]
  );

  // --- Group ---
  const leadsByStage = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    for (const stage of stages) map[stage.id] = [];
    for (const lead of filteredLeads) {
      if (map[lead.estagio_id]) map[lead.estagio_id].push(lead);
    }
    return map;
  }, [filteredLeads, stages]);

  const openNewLead = (stageId: string | null) => {
    setDefaultStageId(stageId);
    setDialogOpen(true);
  };

  // --- Render ---
  const isLoading = pipelinesLoading || leadsLoading;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">Pipeline</h1>
          {activePipeline && (
            <span className="text-sm text-muted-foreground">/ {activePipeline.nome}</span>
          )}
        </div>
        {pipelines.length > 1 && (
          <Select
            value={activePipelineId ?? ''}
            onValueChange={(v) => setActivePipelineId(v)}
          >
            <SelectTrigger className="h-8 w-48">
              <SelectValue placeholder="Pipeline" />
            </SelectTrigger>
            <SelectContent>
              {pipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto">
          <Button onClick={() => openNewLead(null)} disabled={stages.length === 0}>
            <Plus className="h-4 w-4 mr-1" />
            Novo Lead
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou telefone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
        <Select value={tempFilter} onValueChange={(v) => setTempFilter(v as Temperatura | 'ALL')}>
          <SelectTrigger className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todas temperaturas</SelectItem>
            {TEMP_OPTIONS.map((t) => (
              <SelectItem key={t} value={t}>
                {TEMP_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {responsaveis.length > 0 && (
          <Select value={responsavelFilter} onValueChange={setResponsavelFilter}>
            <SelectTrigger className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos responsáveis</SelectItem>
              {responsaveis.map(([id, nome]) => (
                <SelectItem key={id} value={id}>
                  {nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {isLoading ? (
          <div className="flex gap-4 p-4 h-full">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="w-80 flex flex-col gap-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ))}
          </div>
        ) : stages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Nenhum pipeline configurado.</p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-4 p-4 h-full min-w-max">
              {stages.map((stage) => (
                <StageColumn
                  key={stage.id}
                  stage={stage}
                  leads={leadsByStage[stage.id] ?? []}
                  onClickLead={(leadId) => router.push(`/chat/${leadId}`)}
                  onAddLead={(stageId) => openNewLead(stageId)}
                />
              ))}
            </div>
            <DragOverlay>
              {activeDragLead ? (
                <div className="w-80">
                  <LeadCard lead={activeDragLead} isDragging />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      <NewLeadDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        stages={stages}
        defaultStageId={defaultStageId}
        isLoading={createLeadMutation.isPending}
        onSubmit={(data) => createLeadMutation.mutate(data)}
      />
    </div>
  );
}
