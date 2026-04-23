'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
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
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { Search, Plus, Download } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuthStore, useIsPoolEnabled } from '@/stores/auth.store';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

import {
  LeadCard,
  formatBRL,
  type Lead,
  type Temperatura,
  TEMP_LABELS,
} from '@/components/kanban/lead-card';
import { StageColumn, type Stage } from '@/components/kanban/stage-column';
import {
  NewLeadDialog,
  type NewLeadFormData,
} from '@/components/kanban/new-lead-dialog';
import {
  PipelineSwitcher,
  type PipelineSummary,
} from '@/components/kanban/pipeline-switcher';
import { NewPipelineDialog } from '@/components/kanban/new-pipeline-dialog';
import { DeleteWithMoveDialog } from '@/components/kanban/delete-with-move-dialog';
import {
  StageConfigDialog,
  type StageAutoActionForm,
  type StageConfig,
} from '@/components/kanban/stage-config-dialog';
import {
  QuickTaskDialog,
  type QuickTaskFormData,
} from '@/components/kanban/quick-task-dialog';
import { ConfirmDialog } from '@/components/kanban/confirm-dialog';
import { LeadDetailDrawer } from '@/components/kanban/lead-detail-drawer';
import { BulkActionBar } from '@/components/kanban/bulk-action-bar';

interface Pipeline {
  id: string;
  nome: string;
  cor?: string | null;
  arquivado?: boolean;
  stages: Stage[];
}

interface TenantUser {
  id: string;
  nome: string;
  email: string;
  role: string;
}

const TEMP_OPTIONS: Temperatura[] = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'];

export default function KanbanPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isPoolEnabled = useIsPoolEnabled();
  const [activeTab, setActiveTab] = useState<'escritorio' | 'meus'>(() => {
    try { return (localStorage.getItem('kanban-tab') as 'escritorio' | 'meus') ?? 'meus'; }
    catch { return 'meus'; }
  });

  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [tempFilter, setTempFilter] = useState<Temperatura | 'ALL'>('ALL');
  const [responsavelFilter, setResponsavelFilter] = useState<string>('ALL');
  const [activeDragLead, setActiveDragLead] = useState<Lead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultStageId, setDefaultStageId] = useState<string | null>(null);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [deletePipelineId, setDeletePipelineId] = useState<string | null>(null);
  const [stageConfigId, setStageConfigId] = useState<string | null>(null);
  const [quickTaskLeadId, setQuickTaskLeadId] = useState<string | null>(null);
  const [archiveLeadId, setArchiveLeadId] = useState<string | null>(null);
  const [deleteStageId, setDeleteStageId] = useState<string | null>(null);
  const [detailLeadId, setDetailLeadId] = useState<string | null>(null);
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const leadsSnapshotRef = useRef<Lead[] | null>(null);

  const toggleLead = useCallback((id: string) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedLeadIds(new Set());
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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
    [pipelines, activePipelineId],
  );

  const stages = useMemo<Stage[]>(
    () => [...(activePipeline?.stages ?? [])].sort((a, b) => a.ordem - b.ordem),
    [activePipeline],
  );

  // local state for column ordering during drag (optimistic)
  const [stageOrderOverride, setStageOrderOverride] = useState<string[] | null>(null);
  useEffect(() => {
    setStageOrderOverride(null);
  }, [activePipelineId, activePipeline?.stages]);

  const orderedStages = useMemo<Stage[]>(() => {
    if (!stageOrderOverride) return stages;
    const map = new Map(stages.map((s) => [s.id, s]));
    const out: Stage[] = [];
    for (const id of stageOrderOverride) {
      const s = map.get(id);
      if (s) out.push(s);
    }
    return out.length === stages.length ? out : stages;
  }, [stages, stageOrderOverride]);

  const pipelineSummaries = useMemo<PipelineSummary[]>(
    () =>
      pipelines.map((p) => ({
        id: p.id,
        nome: p.nome,
        cor: p.cor ?? '#3b82f6',
        arquivado: p.arquivado ?? false,
      })),
    [pipelines],
  );

  // --- Leads ---
  const leadsQueryKey = useMemo(() => ['leads', activePipelineId] as const, [activePipelineId]);

  const { data: leads = [], isLoading: leadsLoading } = useQuery<Lead[]>({
    queryKey: leadsQueryKey,
    queryFn: async () => {
      if (!activePipelineId) return [];
      const res = await api.get('/api/leads', { params: { pipeline_id: activePipelineId, limit: '10000' } });
      return res.data;
    },
    enabled: !!activePipelineId,
    placeholderData: keepPreviousData,
  });

  const selectAllInStage = useCallback(
    (stageId: string) => {
      const stageLeadIds = leads.filter((l) => l.estagio_id === stageId).map((l) => l.id);
      setSelectedLeadIds((prev) => {
        const next = new Set(prev);
        for (const id of stageLeadIds) next.add(id);
        return next;
      });
    },
    [leads],
  );

  // --- Tenant users (for bulk assign) ---
  const { data: tenantUsers = [] } = useQuery<TenantUser[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await api.get('/api/users/list');
      return res.data as TenantUser[];
    },
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

  const meuCount = useMemo(
    () => filteredLeads.filter((l) => l.responsavel?.id === currentUserId).length,
    [filteredLeads, currentUserId],
  );
  const escritorioCount = useMemo(
    () => filteredLeads.filter((l) => !l.responsavel || l.responsavel.id === currentUserId).length,
    [filteredLeads, currentUserId],
  );

  const tabFilteredLeads = useMemo(() => {
    if (!isPoolEnabled) return filteredLeads;
    if (activeTab === 'meus') return filteredLeads.filter((l) => l.responsavel?.id === currentUserId);
    return filteredLeads.filter((l) => !l.responsavel || l.responsavel.id === currentUserId);
  }, [filteredLeads, isPoolEnabled, activeTab, currentUserId]);

  const responsaveis = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of leads) {
      if (l.responsavel) map.set(l.responsavel.id, l.responsavel.nome);
    }
    return Array.from(map.entries());
  }, [leads]);

  // --- Metrics ---
  const metrics = useMemo(() => {
    const total = leads.length;
    const sumValor = leads.reduce((acc, l) => acc + (Number(l.valor_estimado) || 0), 0);
    const wonStageIds = new Set(stages.filter((s) => s.is_won).map((s) => s.id));
    const wonCount = leads.filter((l) => wonStageIds.has(l.estagio_id)).length;
    const conversion = total > 0 ? (wonCount / total) * 100 : 0;
    return { total, sumValor, conversion };
  }, [leads, stages]);

  // --- Mutations: Pipeline ---
  const createPipelineMutation = useMutation({
    mutationFn: async (data: { nome: string; cor: string }) => {
      const res = await api.post('/api/pipelines', data);
      return res.data;
    },
    onSuccess: (data: Pipeline) => {
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      setNewPipelineOpen(false);
      setActivePipelineId(data.id);
      toast.success('Funil criado!');
    },
    onError: () => toast.error('Erro ao criar funil.'),
  });

  const renamePipelineMutation = useMutation({
    mutationFn: async ({ id, nome }: { id: string; nome: string }) => {
      await api.patch(`/api/pipelines/${id}`, { nome });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
    onError: () => toast.error('Erro ao renomear funil.'),
  });

  const duplicatePipelineMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post(`/api/pipelines/${id}/duplicate`);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      toast.success('Funil duplicado!');
    },
    onError: () => toast.error('Erro ao duplicar funil.'),
  });

  const archivePipelineMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/pipelines/${id}/archive`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      toast.success('Funil arquivado.');
    },
    onError: () => toast.error('Erro ao arquivar funil.'),
  });

  const deleteWithMoveMutation = useMutation({
    mutationFn: async ({ id, targetPipelineId }: { id: string; targetPipelineId: string }) => {
      await api.post(`/api/pipelines/${id}/delete-with-move`, { targetPipelineId });
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setDeletePipelineId(null);
      if (activePipelineId === vars.id) setActivePipelineId(vars.targetPipelineId);
      toast.success('Funil excluido e leads movidos.');
    },
    onError: () => toast.error('Erro ao excluir funil.'),
  });

  // --- Mutations: Stage ---
  const createStageMutation = useMutation({
    mutationFn: async (nome: string) => {
      if (!activePipelineId) return;
      await api.post(`/api/pipelines/${activePipelineId}/stages`, { nome, cor: '#3498DB' });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
    onError: () => toast.error('Erro ao criar etapa.'),
  });

  const updateStageMutation = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Record<string, unknown>;
    }) => {
      await api.patch(`/api/stages/${id}`, patch);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
    onError: () => toast.error('Erro ao atualizar etapa.'),
  });

  const deleteStageMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/stages/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
    onError: () => toast.error('Erro ao excluir etapa.'),
  });

  const reorderStagesMutation = useMutation({
    mutationFn: async (stageIds: string[]) => {
      if (!activePipelineId) return;
      await api.post(`/api/pipelines/${activePipelineId}/stages/reorder`, { stageIds });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
    onError: () => {
      setStageOrderOverride(null);
      toast.error('Erro ao reordenar etapas.');
    },
  });

  // --- Mutations: Leads ---
  const stageMutation = useMutation({
    mutationFn: async ({
      leadId,
      estagioId,
      position,
    }: {
      leadId: string;
      estagioId: string;
      position?: number;
    }) => {
      await api.patch(`/api/leads/${leadId}/stage`, {
        estagio_id: estagioId,
        ...(position !== undefined ? { position } : {}),
      });
    },
    onError: () => {
      if (leadsSnapshotRef.current) {
        queryClient.setQueryData(leadsQueryKey, leadsSnapshotRef.current);
        leadsSnapshotRef.current = null;
      }
      toast.error('Erro ao mover lead.');
    },
    onSuccess: (_data, vars) => {
      leadsSnapshotRef.current = null;
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead-activities', vars.leadId] });
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
    onError: () => toast.error('Erro ao criar lead.'),
  });

  const archiveLeadMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/leads/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setArchiveLeadId(null);
      toast.success('Lead arquivado.');
    },
    onError: () => toast.error('Erro ao arquivar lead.'),
  });

  const quickTaskMutation = useMutation({
    mutationFn: async ({ leadId, data }: { leadId: string; data: QuickTaskFormData }) => {
      await api.post('/api/tasks', { ...data, lead_id: leadId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setQuickTaskLeadId(null);
      toast.success('Tarefa criada.');
    },
    onError: () => toast.error('Erro ao criar tarefa.'),
  });

  // --- Socket ---
  useEffect(() => {
    const socket = getSocket();
    const handleStageChanged = (payload: { triggeredByUserId?: string }) => {
      // Skip invalidation for own drag-drop — the optimistic update + stageMutation already handle it.
      if (payload?.triggeredByUserId && payload.triggeredByUserId === currentUserId) return;
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    };
    const handleNewMessage = (data: { leadId: string; message?: { content?: string } }) => {
      queryClient.setQueryData<Lead[]>(leadsQueryKey, (old) => {
        if (!old) return old;
        let matched = false;
        const updated = old.map((l) => {
          if (l.id !== data.leadId) return l;
          matched = true;
          return {
            ...l,
            mensagens_nao_lidas: l.mensagens_nao_lidas + 1,
            ultima_mensagem_preview: data.message?.content ?? l.ultima_mensagem_preview,
            ultima_interacao: new Date().toISOString(),
          };
        });
        // If lead isn't in the current pipeline cache (e.g. new lead created
        // by the webhook), refetch so it appears on the board.
        if (!matched) {
          queryClient.invalidateQueries({ queryKey: leadsQueryKey });
        }
        return updated;
      });
    };
    const handleUnreadReset = (data: { leadId: string }) => {
      queryClient.setQueryData<Lead[]>(leadsQueryKey, (old) => {
        if (!old) return old;
        return old.map((l) =>
          l.id === data.leadId ? { ...l, mensagens_nao_lidas: 0 } : l,
        );
      });
    };
    socket.on('lead:stage-changed', handleStageChanged);
    socket.on('lead:new-message', handleNewMessage);
    socket.on('lead:unread-reset', handleUnreadReset);
    return () => {
      socket.off('lead:stage-changed', handleStageChanged);
      socket.off('lead:new-message', handleNewMessage);
      socket.off('lead:unread-reset', handleUnreadReset);
    };
  }, [queryClient, leadsQueryKey, currentUserId]);

  // --- DnD ---
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      if (id.startsWith('stage-')) return;
      const lead = leads.find((l) => l.id === id);
      if (lead) setActiveDragLead(lead);
    },
    [leads],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragLead(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = String(active.id);
      const overId = String(over.id);

      // Stage column reorder
      if (activeId.startsWith('stage-') && overId.startsWith('stage-')) {
        if (activeId === overId) return;
        const ids = orderedStages.map((s) => s.id);
        const fromId = activeId.replace('stage-', '');
        const toId = overId.replace('stage-', '');
        const from = ids.indexOf(fromId);
        const to = ids.indexOf(toId);
        if (from < 0 || to < 0) return;
        const next = arrayMove(ids, from, to);
        setStageOrderOverride(next);
        reorderStagesMutation.mutate(next);
        return;
      }

      // Lead drag
      // TODO: bulk drag not implemented — only single drag works; bulk move via BulkActionBar
      const lead = leads.find((l) => l.id === activeId);
      if (!lead) return;
      let targetStageId: string | null = null;
      if (overId.startsWith('column-')) {
        targetStageId = overId.replace('column-', '');
      } else {
        const overLead = leads.find((l) => l.id === overId);
        if (overLead) targetStageId = overLead.estagio_id;
      }
      if (!targetStageId) return;

      leadsSnapshotRef.current = leads;

      if (targetStageId === lead.estagio_id) {
        // Same-stage reorder: compute fractional position between neighbors.
        const stageLeads = leads
          .filter((l) => l.estagio_id === targetStageId)
          .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));

        const fromIdx = stageLeads.findIndex((l) => l.id === activeId);
        const overLead = leads.find((l) => l.id === overId);
        const toIdx = overLead ? stageLeads.findIndex((l) => l.id === overId) : stageLeads.length - 1;

        if (fromIdx < 0 || fromIdx === toIdx) {
          leadsSnapshotRef.current = null;
          return;
        }

        // Compute neighbors in the final sorted array (after the move) to derive the new position.
        const reorderedForPos = arrayMove(stageLeads, fromIdx, toIdx);
        const prev = reorderedForPos[toIdx - 1];
        const next = reorderedForPos[toIdx + 1];

        let newPosition: number;
        if (!prev && !next) {
          newPosition = 1000;
        } else if (!prev) {
          newPosition = (next.position ?? toIdx * 1000) - 1000;
        } else if (!next) {
          newPosition = (prev.position ?? toIdx * 1000) + 1000;
        } else {
          const prevPos = prev.position ?? (toIdx - 1) * 1000;
          const nextPos = next.position ?? (toIdx + 1) * 1000;
          newPosition = (prevPos + nextPos) / 2;
        }

        // Optimistic update: reorder leads in cache.
        queryClient.setQueryData<Lead[]>(leadsQueryKey, (old) => {
          if (!old) return old;
          const stageSet = new Set(stageLeads.map((l) => l.id));
          const others = old.filter((l) => !stageSet.has(l.id));
          const updated = reorderedForPos.map((l) =>
            l.id === activeId ? { ...l, position: newPosition } : l,
          );
          return [...others, ...updated];
        });

        stageMutation.mutate({ leadId: activeId, estagioId: targetStageId, position: newPosition });
        return;
      }

      // Cross-stage move
      const finalTarget = targetStageId;
      queryClient.setQueryData<Lead[]>(leadsQueryKey, (old) =>
        old?.map((l) => (l.id === activeId ? { ...l, estagio_id: finalTarget } : l)),
      );
      stageMutation.mutate({ leadId: activeId, estagioId: finalTarget });
    },
    [leads, queryClient, leadsQueryKey, stageMutation, orderedStages, reorderStagesMutation],
  );

  // --- Group ---
  const leadsByStage = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    for (const stage of orderedStages) map[stage.id] = [];
    for (const lead of tabFilteredLeads) {
      if (map[lead.estagio_id]) map[lead.estagio_id].push(lead);
    }
    for (const stageId of Object.keys(map)) {
      map[stageId].sort(
        (a, b) =>
          (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
      );
    }
    return map;
  }, [tabFilteredLeads, orderedStages]);

  const claimLeadMutation = useMutation({
    mutationFn: async (leadId: string) => {
      await api.post(`/api/leads/${leadId}/claim`);
    },
    onSuccess: () => {
      toast.success('Lead assumido!');
      queryClient.invalidateQueries({ queryKey: leadsQueryKey });
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) toast.error('Lead já foi assumido por outro colega');
      else toast.error('Erro ao assumir lead. Tente novamente.');
    },
  });

  const handleClaimLead = async (leadId: string) => {
    await claimLeadMutation.mutateAsync(leadId);
  };

  const openNewLead = (stageId: string | null) => {
    setDefaultStageId(stageId);
    setDialogOpen(true);
  };

  const handleExportLeads = useCallback(async () => {
    const params = new URLSearchParams();
    if (activePipelineId) params.set('pipeline_id', activePipelineId);
    if (tempFilter !== 'ALL') params.set('temperatura', tempFilter);
    if (responsavelFilter !== 'ALL') params.set('responsavel_id', responsavelFilter);
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    try {
      const response = await fetch(`/api/leads/export?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error('Falha ao exportar');
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `leads-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(downloadUrl);
    } catch {
      toast.error('Erro ao exportar leads.');
    }
  }, [activePipelineId, tempFilter, responsavelFilter]);

  // --- Stage handlers ---
  const handleRenameStage = useCallback(
    (id: string, nome: string) => updateStageMutation.mutate({ id, patch: { nome } }),
    [updateStageMutation],
  );
  const handleChangeColor = useCallback(
    (id: string, cor: string) => updateStageMutation.mutate({ id, patch: { cor } }),
    [updateStageMutation],
  );
  const handleDuplicateStage = useCallback(
    (id: string) => {
      const s = stages.find((x) => x.id === id);
      if (!s) return;
      createStageMutation.mutate(`${s.nome} (copia)`);
    },
    [stages, createStageMutation],
  );
  const handleDeleteStage = useCallback((id: string) => {
    setDeleteStageId(id);
  }, []);
  const handleConfigureStage = useCallback((id: string) => {
    setStageConfigId(id);
  }, []);
  const handleMoveStage = useCallback(
    (id: string, dir: -1 | 1) => {
      const ids = orderedStages.map((s) => s.id);
      const idx = ids.indexOf(id);
      if (idx < 0) return;
      const j = idx + dir;
      if (j < 0 || j >= ids.length) return;
      const next = arrayMove(ids, idx, j);
      setStageOrderOverride(next);
      reorderStagesMutation.mutate(next);
    },
    [orderedStages, reorderStagesMutation],
  );

  const stageBeingConfigured = useMemo<StageConfig | null>(() => {
    if (!stageConfigId) return null;
    const s = stages.find((x) => x.id === stageConfigId);
    if (!s) return null;
    return {
      id: s.id,
      nome: s.nome,
      cor: s.cor,
      is_won: s.is_won ?? false,
      is_lost: s.is_lost ?? false,
      max_dias: s.max_dias ?? null,
      auto_action: (s.auto_action as StageAutoActionForm | null) ?? null,
      sla_config: s.sla_config ?? null,
      idle_alert_config: s.idle_alert_config ?? null,
      response_alert_config: (s as any).response_alert_config ?? null,
      on_entry_config: s.on_entry_config ?? null,
      cadence_config: s.cadence_config ?? null,
    };
  }, [stageConfigId, stages]);

  const handleSubmitStageConfig = (patch: any) => {
    if (!stageConfigId) return;
    updateStageMutation.mutate(
      { id: stageConfigId, patch },
      { onSuccess: () => setStageConfigId(null) },
    );
  };

  // --- Render ---
  const isLoading = pipelinesLoading || leadsLoading;
  const stageSortableIds = useMemo(() => orderedStages.map((s) => `stage-${s.id}`), [orderedStages]);

  return (
    <div className="flex flex-col h-full">
      {/* Header with PipelineSwitcher */}
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <h1 className="text-lg font-semibold shrink-0">Pipeline</h1>
        <div className="flex-1 min-w-0">
          <PipelineSwitcher
            pipelines={pipelineSummaries}
            activeId={activePipelineId}
            onSelect={setActivePipelineId}
            onCreate={() => setNewPipelineOpen(true)}
            onRename={(id, nome) => renamePipelineMutation.mutate({ id, nome })}
            onDuplicate={(id) => duplicatePipelineMutation.mutate(id)}
            onArchive={(id) => archivePipelineMutation.mutate(id)}
            onDeleteWithMove={(id) => setDeletePipelineId(id)}
          />
        </div>
        <Button onClick={() => openNewLead(null)} disabled={stages.length === 0}>
          <Plus className="h-4 w-4 mr-1" />
          Novo Lead
        </Button>
      </div>

      {/* Metrics header */}
      <div className="grid grid-cols-3 gap-2 px-4 py-2 border-b bg-muted/20">
        <div className="rounded-md border bg-background px-3 py-2">
          <p className="text-[11px] uppercase text-muted-foreground">Total de leads</p>
          <p className="text-lg font-semibold tabular-nums">{metrics.total}</p>
        </div>
        <div className="rounded-md border bg-background px-3 py-2">
          <p className="text-[11px] uppercase text-muted-foreground">Valor total</p>
          <p className="text-lg font-semibold tabular-nums text-emerald-500">
            {formatBRL(String(metrics.sumValor))}
          </p>
        </div>
        <div className="rounded-md border bg-background px-3 py-2">
          <p className="text-[11px] uppercase text-muted-foreground">Conversao</p>
          <p className="text-lg font-semibold tabular-nums">
            {metrics.conversion.toFixed(1)}%
          </p>
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
              <SelectItem value="ALL">Todos responsaveis</SelectItem>
              {responsaveis.map(([id, nome]) => (
                <SelectItem key={id} value={id}>
                  {nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={handleExportLeads}>
          <Download className="h-4 w-4" />
          Exportar CSV
        </Button>
      </div>

      {/* Pool tabs */}
      {isPoolEnabled && (
        <div className="px-4 pt-2 border-b">
          <Tabs
            value={activeTab}
            onValueChange={(v) => {
              const tab = v as 'escritorio' | 'meus';
              setActiveTab(tab);
              try { localStorage.setItem('kanban-tab', tab); } catch { /* noop */ }
            }}
          >
            <TabsList>
              <TabsTrigger value="escritorio">
                📂 Escritório ({escritorioCount})
              </TabsTrigger>
              <TabsTrigger value="meus">
                👤 Meus Leads ({meuCount})
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

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
        ) : orderedStages.length === 0 ? (
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
            <SortableContext items={stageSortableIds} strategy={horizontalListSortingStrategy}>
              <div className="flex gap-4 p-4 h-full min-w-max">
                {orderedStages.map((stage, idx) => (
                  <StageColumn
                    key={stage.id}
                    stage={stage}
                    leads={leadsByStage[stage.id] ?? []}
                    onClickLead={(leadId) => router.push(`/chat/${leadId}`)}
                    onAddLead={(stageId) => openNewLead(stageId)}
                    onRenameStage={handleRenameStage}
                    onChangeColor={handleChangeColor}
                    onDuplicateStage={handleDuplicateStage}
                    onDeleteStage={handleDeleteStage}
                    onConfigureStage={handleConfigureStage}
                    onMoveStage={handleMoveStage}
                    canMoveLeft={idx > 0}
                    canMoveRight={idx < orderedStages.length - 1}
                    onQuickTaskLead={(leadId) => setQuickTaskLeadId(leadId)}
                    onArchiveLead={(leadId) => setArchiveLeadId(leadId)}
                    onOpenDetail={(leadId) => setDetailLeadId(leadId)}
                    onClaimLead={handleClaimLead}
                    isPoolEnabled={isPoolEnabled}
                    selectedLeadIds={selectedLeadIds}
                    onToggleSelect={toggleLead}
                    onSelectAllInStage={selectAllInStage}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const nome = prompt('Nome da nova etapa:');
                    if (nome && nome.trim()) createStageMutation.mutate(nome.trim());
                  }}
                  className="flex-shrink-0 w-56 h-12 flex items-center justify-center gap-1.5 rounded-lg border border-dashed text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors self-start"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Adicionar Etapa
                </button>
              </div>
            </SortableContext>
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

      <NewPipelineDialog
        open={newPipelineOpen}
        onOpenChange={setNewPipelineOpen}
        isLoading={createPipelineMutation.isPending}
        onSubmit={(data) => createPipelineMutation.mutate(data)}
      />

      <DeleteWithMoveDialog
        open={!!deletePipelineId}
        onOpenChange={(o) => !o && setDeletePipelineId(null)}
        sourceId={deletePipelineId}
        pipelines={pipelineSummaries}
        isLoading={deleteWithMoveMutation.isPending}
        onSubmit={(targetPipelineId) =>
          deletePipelineId &&
          deleteWithMoveMutation.mutate({ id: deletePipelineId, targetPipelineId })
        }
      />

      <StageConfigDialog
        open={!!stageConfigId}
        onOpenChange={(o) => !o && setStageConfigId(null)}
        stage={stageBeingConfigured}
        allStages={stages
          .filter((s) => s.id !== stageConfigId)
          .map((s) => ({ id: s.id, nome: s.nome }))}
        isLoading={updateStageMutation.isPending}
        onSubmit={handleSubmitStageConfig}
      />

      <QuickTaskDialog
        open={!!quickTaskLeadId}
        onOpenChange={(o) => !o && setQuickTaskLeadId(null)}
        isLoading={quickTaskMutation.isPending}
        onSubmit={(data) =>
          quickTaskLeadId && quickTaskMutation.mutate({ leadId: quickTaskLeadId, data })
        }
      />

      <ConfirmDialog
        open={!!archiveLeadId}
        onOpenChange={(o) => !o && setArchiveLeadId(null)}
        title="Arquivar lead?"
        description="O lead sera removido do funil. Esta acao nao pode ser desfeita."
        confirmLabel="Arquivar"
        destructive
        isLoading={archiveLeadMutation.isPending}
        onConfirm={() => archiveLeadId && archiveLeadMutation.mutate(archiveLeadId)}
      />

      <ConfirmDialog
        open={!!deleteStageId}
        onOpenChange={(o) => !o && setDeleteStageId(null)}
        title="Excluir etapa?"
        description="Leads desta etapa precisarao ser movidos antes. Esta acao nao pode ser desfeita."
        confirmLabel="Excluir"
        destructive
        isLoading={deleteStageMutation.isPending}
        onConfirm={() =>
          deleteStageId &&
          deleteStageMutation.mutate(deleteStageId, {
            onSuccess: () => setDeleteStageId(null),
          })
        }
      />

      <LeadDetailDrawer
        leadId={detailLeadId}
        open={!!detailLeadId}
        onClose={() => setDetailLeadId(null)}
        activePipelineId={activePipelineId}
        onArchive={(id) => setArchiveLeadId(id)}
      />

      {selectedLeadIds.size > 0 && activePipelineId && (
        <BulkActionBar
          selectedCount={selectedLeadIds.size}
          selectedIds={Array.from(selectedLeadIds)}
          stages={stages}
          users={tenantUsers}
          onClear={clearSelection}
          activePipelineId={activePipelineId}
          queryClient={queryClient}
        />
      )}
    </div>
  );
}
