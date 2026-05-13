'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, Trophy, XCircle, Palette } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Tabs,
  TabsList,
  TabsTrigger,
  Badge,
  Switch,
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Textarea,
} from '@/components/ui';

interface Stage {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
  pipeline_id: string;
  is_won: boolean;
  is_lost: boolean;
  _count?: { leads: number };
}

interface Pipeline {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  ordem: number;
  stages: Stage[];
  _count?: { leads: number };
}

const SWATCHES = [
  '#3498DB',
  '#27AE60',
  '#F39C12',
  '#E74C3C',
  '#9B59B6',
  '#1ABC9C',
  '#34495E',
  '#E67E22',
];

export default function PipelineEditorPage() {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineNome, setNewPipelineNome] = useState('');
  const [newPipelineDesc, setNewPipelineDesc] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<
    { type: 'pipeline' | 'stage'; id: string; nome: string } | null
  >(null);
  const [moveStageDialog, setMoveStageDialog] = useState<
    { id: string; nome: string; leadsCount: number } | null
  >(null);
  const [moveTargetStageId, setMoveTargetStageId] = useState<string>('');

  const { data: pipelines = [], isLoading } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data;
    },
  });

  useEffect(() => {
    if (!activeId && pipelines.length > 0) setActiveId(pipelines[0].id);
    if (activeId && pipelines.length > 0 && !pipelines.find((p) => p.id === activeId)) {
      setActiveId(pipelines[0].id);
    }
  }, [pipelines, activeId]);

  const activePipeline = useMemo(
    () => pipelines.find((p) => p.id === activeId),
    [pipelines, activeId],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pipelines'] });

  const createPipeline = useMutation({
    mutationFn: async (body: { nome: string; descricao?: string }) => {
      const res = await api.post('/api/pipelines', body);
      return res.data as Pipeline;
    },
    onSuccess: (created) => {
      toast.success('Pipeline criado');
      setNewPipelineOpen(false);
      setNewPipelineNome('');
      setNewPipelineDesc('');
      setActiveId(created.id);
      invalidate();
    },
    onError: () => toast.error('Erro ao criar pipeline'),
  });

  const updatePipeline = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: Partial<Pick<Pipeline, 'nome' | 'descricao' | 'ativo'>>;
    }) => {
      const res = await api.patch(`/api/pipelines/${id}`, data);
      return res.data;
    },
    onSuccess: () => {
      toast.success('Pipeline atualizado');
      invalidate();
    },
    onError: () => toast.error('Erro ao atualizar pipeline'),
  });

  const deletePipeline = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/pipelines/${id}`);
    },
    onSuccess: () => {
      toast.success('Pipeline removido');
      setConfirmDelete(null);
      setActiveId(null);
      invalidate();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Erro ao remover pipeline';
      toast.error(msg);
    },
  });

  const createStage = useMutation({
    mutationFn: async ({ pipelineId, nome }: { pipelineId: string; nome: string }) => {
      const res = await api.post(`/api/pipelines/${pipelineId}/stages`, {
        nome,
        cor: '#3498DB',
      });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Stage adicionada');
      invalidate();
    },
    onError: () => toast.error('Erro ao criar stage'),
  });

  const updateStage = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: Partial<Pick<Stage, 'nome' | 'cor' | 'is_won' | 'is_lost'>>;
    }) => {
      const res = await api.patch(`/api/stages/${id}`, data);
      return res.data;
    },
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: ['pipelines'] });
      const prev = qc.getQueryData<Pipeline[]>(['pipelines']);
      if (prev) {
        qc.setQueryData<Pipeline[]>(
          ['pipelines'],
          prev.map((p) => ({
            ...p,
            stages: p.stages.map((s) => (s.id === id ? { ...s, ...data } : s)),
          })),
        );
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['pipelines'], ctx.prev);
      toast.error('Erro ao atualizar stage');
    },
    onSuccess: () => invalidate(),
  });

  const deleteStage = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/stages/${id}`);
    },
    onSuccess: () => {
      toast.success('Stage removida');
      setConfirmDelete(null);
      invalidate();
    },
    onError: (err: unknown, id) => {
      const response = (err as { response?: { data?: { message?: string }; status?: number } })
        ?.response;
      const msg = response?.data?.message ?? 'Erro ao remover stage';
      // 409 with leads → open move dialog instead of plain toast.
      if (response?.status === 409 && /leads nesta stage/i.test(msg) && activePipeline) {
        const stage = activePipeline.stages.find((s) => s.id === id);
        if (stage) {
          setConfirmDelete(null);
          setMoveStageDialog({
            id,
            nome: stage.nome,
            leadsCount: stage._count?.leads ?? 0,
          });
          const firstOther = activePipeline.stages.find((s) => s.id !== id);
          setMoveTargetStageId(firstOther?.id ?? '');
          return;
        }
      }
      toast.error(msg);
    },
  });

  const deleteStageWithMove = useMutation({
    mutationFn: async ({ id, targetStageId }: { id: string; targetStageId: string }) => {
      await api.post(`/api/stages/${id}/delete-with-move`, { targetStageId });
    },
    onSuccess: () => {
      toast.success('Stage removida (leads movidos)');
      setMoveStageDialog(null);
      setMoveTargetStageId('');
      invalidate();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Erro ao mover leads e remover stage';
      toast.error(msg);
    },
  });

  const reorderStages = useMutation({
    mutationFn: async ({ pipelineId, stageIds }: { pipelineId: string; stageIds: string[] }) => {
      await api.post(`/api/pipelines/${pipelineId}/stages/reorder`, { stageIds });
    },
    onMutate: async ({ pipelineId, stageIds }) => {
      await qc.cancelQueries({ queryKey: ['pipelines'] });
      const prev = qc.getQueryData<Pipeline[]>(['pipelines']);
      if (prev) {
        qc.setQueryData<Pipeline[]>(
          ['pipelines'],
          prev.map((p) => {
            if (p.id !== pipelineId) return p;
            const byId = new Map(p.stages.map((s) => [s.id, s]));
            const next = stageIds
              .map((id, idx) => {
                const st = byId.get(id);
                return st ? { ...st, ordem: idx } : null;
              })
              .filter((s): s is Stage => s !== null);
            return { ...p, stages: next };
          }),
        );
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['pipelines'], ctx.prev);
      toast.error('Erro ao reordenar');
    },
    onSuccess: () => invalidate(),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || !activePipeline || active.id === over.id) return;
    const stages = [...activePipeline.stages].sort((a, b) => a.ordem - b.ordem);
    const oldIndex = stages.findIndex((s) => s.id === active.id);
    const newIndex = stages.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(stages, oldIndex, newIndex);
    reorderStages.mutate({
      pipelineId: activePipeline.id,
      stageIds: next.map((s) => s.id),
    });
  };

  return (
    <TooltipProvider>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              Editor de Pipeline
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Gerencie seus pipelines de vendas, etapas, cores e regras de ganho/perda.
            </p>
          </div>
          <Button onClick={() => setNewPipelineOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Novo Pipeline
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando...</p>
        ) : pipelines.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-sm text-muted-foreground mb-4">
                Nenhum pipeline criado ainda.
              </p>
              <Button onClick={() => setNewPipelineOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Criar primeiro pipeline
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {pipelines.length > 1 && (
              <Tabs value={activeId ?? ''} onValueChange={(v) => setActiveId(v)}>
                <TabsList>
                  {pipelines.map((p) => (
                    <TabsTrigger key={p.id} value={p.id}>
                      {p.nome}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}

            {activePipeline && (
              <Card>
                <CardHeader className="space-y-3">
                  <InlineEditable
                    value={activePipeline.nome}
                    className="text-xl font-semibold"
                    placeholder="Nome do pipeline"
                    onSave={(nome) => {
                      if (nome && nome !== activePipeline.nome) {
                        updatePipeline.mutate({ id: activePipeline.id, data: { nome } });
                      }
                    }}
                  />
                  <InlineEditable
                    value={activePipeline.descricao ?? ''}
                    className="text-sm text-muted-foreground"
                    placeholder="Adicionar descricao..."
                    multiline
                    onSave={(descricao) => {
                      if (descricao !== (activePipeline.descricao ?? '')) {
                        updatePipeline.mutate({
                          id: activePipeline.id,
                          data: { descricao },
                        });
                      }
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                      {activePipeline._count?.leads ?? 0} leads
                    </Badge>
                    <Badge variant="secondary">
                      {activePipeline.stages.length} stages
                    </Badge>
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setConfirmDelete({
                          type: 'pipeline',
                          id: activePipeline.id,
                          nome: activePipeline.nome,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Excluir pipeline
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Stages
                  </Label>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={[...activePipeline.stages]
                        .sort((a, b) => a.ordem - b.ordem)
                        .map((s) => s.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-2">
                        {[...activePipeline.stages]
                          .sort((a, b) => a.ordem - b.ordem)
                          .map((stage) => (
                            <SortableStageRow
                              key={stage.id}
                              stage={stage}
                              onUpdate={(data) =>
                                updateStage.mutate({ id: stage.id, data })
                              }
                              onDelete={() =>
                                setConfirmDelete({
                                  type: 'stage',
                                  id: stage.id,
                                  nome: stage.nome,
                                })
                              }
                            />
                          ))}
                      </div>
                    </SortableContext>
                  </DndContext>

                  <Button
                    variant="outline"
                    className="w-full mt-3"
                    onClick={() => {
                      const nome = window.prompt('Nome da nova stage:');
                      if (nome && nome.trim()) {
                        createStage.mutate({
                          pipelineId: activePipeline.id,
                          nome: nome.trim(),
                        });
                      }
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Adicionar Stage
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Novo Pipeline */}
        <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Novo Pipeline</DialogTitle>
              <DialogDescription>
                Cria um pipeline com 3 stages padrao (Novo Lead, Em Negociacao, Fechado).
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="np-nome">Nome</Label>
                <Input
                  id="np-nome"
                  value={newPipelineNome}
                  onChange={(e) => setNewPipelineNome(e.target.value)}
                  placeholder="Ex: Vendas B2B"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="np-desc">Descricao</Label>
                <Textarea
                  id="np-desc"
                  value={newPipelineDesc}
                  onChange={(e) => setNewPipelineDesc(e.target.value)}
                  placeholder="Opcional"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setNewPipelineOpen(false)}>
                Cancelar
              </Button>
              <Button
                disabled={!newPipelineNome.trim() || createPipeline.isPending}
                onClick={() =>
                  createPipeline.mutate({
                    nome: newPipelineNome.trim(),
                    descricao: newPipelineDesc.trim() || undefined,
                  })
                }
              >
                Criar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Move leads + delete stage */}
        <Dialog
          open={!!moveStageDialog}
          onOpenChange={(o) => {
            if (!o) {
              setMoveStageDialog(null);
              setMoveTargetStageId('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Etapa contem leads</DialogTitle>
              <DialogDescription>
                A etapa <strong>{moveStageDialog?.nome}</strong> tem{' '}
                {moveStageDialog?.leadsCount ?? 0} lead(s). Escolha uma etapa de destino
                para mover os leads antes de excluir.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="move-target">Mover leads para</Label>
              <select
                id="move-target"
                value={moveTargetStageId}
                onChange={(e) => setMoveTargetStageId(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">Selecione uma etapa</option>
                {activePipeline?.stages
                  .filter((s) => s.id !== moveStageDialog?.id)
                  .sort((a, b) => a.ordem - b.ordem)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nome}
                    </option>
                  ))}
              </select>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setMoveStageDialog(null);
                  setMoveTargetStageId('');
                }}
              >
                Cancelar
              </Button>
              <Button
                variant="destructive"
                disabled={!moveTargetStageId || deleteStageWithMove.isPending}
                onClick={() => {
                  if (!moveStageDialog || !moveTargetStageId) return;
                  deleteStageWithMove.mutate({
                    id: moveStageDialog.id,
                    targetStageId: moveTargetStageId,
                  });
                }}
              >
                Mover e excluir
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Confirm delete */}
        <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirmar exclusao</DialogTitle>
              <DialogDescription>
                Tem certeza que deseja excluir{' '}
                {confirmDelete?.type === 'pipeline' ? 'o pipeline' : 'a stage'}{' '}
                <strong>{confirmDelete?.nome}</strong>? Esta acao nao pode ser desfeita.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancelar
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (!confirmDelete) return;
                  if (confirmDelete.type === 'pipeline') {
                    deletePipeline.mutate(confirmDelete.id);
                  } else {
                    deleteStage.mutate(confirmDelete.id);
                  }
                }}
              >
                Excluir
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

function InlineEditable({
  value,
  onSave,
  placeholder,
  className,
  multiline,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`text-left w-full hover:bg-muted/40 rounded px-1 -mx-1 ${className ?? ''}`}
      >
        {value || <span className="italic opacity-60">{placeholder}</span>}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    onSave(draft.trim());
  };
  if (multiline) {
    return (
      <Textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        className={className}
      />
    );
  }
  return (
    <Input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      placeholder={placeholder}
      className={className}
    />
  );
}

function SortableStageRow({
  stage,
  onUpdate,
  onDelete,
}: {
  stage: Stage;
  onUpdate: (data: Partial<Pick<Stage, 'nome' | 'cor' | 'is_won' | 'is_lost'>>) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-lg border bg-card p-3"
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
        aria-label="Arrastar"
      >
        <GripVertical className="h-5 w-5" />
      </button>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="h-6 w-6 rounded-full border shadow-sm"
            style={{ backgroundColor: stage.cor }}
            aria-label="Alterar cor"
          />
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Palette className="h-3 w-3" />
              Cor da stage
            </div>
            <div className="grid grid-cols-4 gap-2">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onUpdate({ cor: c })}
                  className="h-7 w-7 rounded-full border shadow-sm hover:scale-110 transition"
                  style={{ backgroundColor: c }}
                  aria-label={c}
                />
              ))}
            </div>
            <input
              type="color"
              value={stage.cor}
              onChange={(e) => onUpdate({ cor: e.target.value })}
              className="w-full h-8 cursor-pointer rounded"
            />
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex-1 min-w-0">
        <InlineEditable
          value={stage.nome}
          className="font-medium"
          onSave={(nome) => {
            if (nome && nome !== stage.nome) onUpdate({ nome });
          }}
        />
        {stage._count && stage._count.leads > 0 && (
          <span className="text-xs text-muted-foreground">{stage._count.leads} leads</span>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <label className="flex items-center gap-1.5 text-xs">
            <Trophy
              className={`h-3.5 w-3.5 ${stage.is_won ? 'text-green-600' : 'text-muted-foreground'}`}
            />
            <Switch
              checked={stage.is_won}
              onCheckedChange={(v) =>
                onUpdate({ is_won: v, is_lost: v ? false : stage.is_lost })
              }
            />
          </label>
        </TooltipTrigger>
        <TooltipContent>Marcar como ganho</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <label className="flex items-center gap-1.5 text-xs">
            <XCircle
              className={`h-3.5 w-3.5 ${stage.is_lost ? 'text-red-600' : 'text-muted-foreground'}`}
            />
            <Switch
              checked={stage.is_lost}
              onCheckedChange={(v) =>
                onUpdate({ is_lost: v, is_won: v ? false : stage.is_won })
              }
            />
          </label>
        </TooltipTrigger>
        <TooltipContent>Marcar como perdido</TooltipContent>
      </Tooltip>

      <Button variant="ghost" size="sm" onClick={onDelete}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
