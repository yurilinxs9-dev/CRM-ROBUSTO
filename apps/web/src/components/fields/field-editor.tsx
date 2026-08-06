'use client';

import { useState } from 'react';
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
import { GripVertical, Plus, Trash2, Eye, EyeOff, Pencil, Lock } from 'lucide-react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import {
  groupFields,
  type FieldDef,
  type FieldSchema,
  type FieldScope,
  type FieldType,
  type GroupWithFields,
} from '@/lib/field-render';

const TIPO_LABELS: Record<FieldType, string> = {
  text: 'Texto',
  textarea: 'Texto longo',
  number: 'Número',
  currency: 'Moeda',
  date: 'Data',
  select: 'Seleção',
  multiselect: 'Seleção múltipla',
  boolean: 'Sim/Não',
  url: 'URL',
  phone: 'Telefone',
  email: 'E-mail',
};

const TIPOS_COM_OPCOES: FieldType[] = ['select', 'multiselect'];

const ESCOPO_TITULOS: Record<FieldScope, string> = {
  LEAD: 'Campos do lead',
  CONTATO: 'Campo do contato',
  EMPRESA: 'Campos da empresa',
};

function erroDe(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
  return msg ?? fallback;
}

// ---------------------------------------------------------------------------
// Linha arrastável
// ---------------------------------------------------------------------------

function SortableFieldRow({
  def,
  onEditar,
  onAlternarVisivel,
  onRemover,
}: {
  def: FieldDef;
  onEditar: () => void;
  onAlternarVisivel: () => void;
  onRemover: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: def.id,
  });
  const nativo = !!def.native_key;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={cn(
        'flex items-center gap-2 rounded-md border bg-card px-3 py-2',
        !def.visible && 'opacity-60',
      )}
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
        aria-label={`Reordenar ${def.nome}`}
      >
        <GripVertical size={16} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{def.nome}</span>
          {nativo && (
            <Lock size={11} className="shrink-0 text-muted-foreground" aria-label="Campo nativo" />
          )}
        </div>
        {def.options?.length ? (
          <p className="truncate text-xs text-muted-foreground">{def.options.join(' · ')}</p>
        ) : null}
      </div>

      {def.api_only && (
        <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
          Apenas API
        </Badge>
      )}
      <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
        {TIPO_LABELS[def.tipo] ?? def.tipo}
      </Badge>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={onEditar}
        title="Renomear"
      >
        <Pencil size={13} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={onAlternarVisivel}
        title={def.visible ? 'Esconder da ficha' : 'Mostrar na ficha'}
      >
        {def.visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </Button>
      {/* Campo nativo não é removível — só pode ser escondido. */}
      {!nativo && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-destructive"
          onClick={onRemover}
          title="Remover campo"
        >
          <Trash2 size={13} />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloco de um escopo
// ---------------------------------------------------------------------------

function BlocoEscopo({
  escopo,
  grupos,
  onReordenar,
  onNovoCampo,
  onNovoGrupo,
  onEditar,
  onAlternarVisivel,
  onRemover,
}: {
  escopo: FieldScope;
  grupos: GroupWithFields[];
  onReordenar: (grupoId: string, ids: string[]) => void;
  onNovoCampo: (escopo: FieldScope, grupoId: string) => void;
  onNovoGrupo: (escopo: FieldScope) => void;
  onEditar: (def: FieldDef) => void;
  onAlternarVisivel: (def: FieldDef) => void;
  onRemover: (def: FieldDef) => void;
}) {
  const [grupoAtivo, setGrupoAtivo] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (grupos.length === 0) return null;
  const ativo = grupos.find((g) => g.id === grupoAtivo) ?? grupos[0];

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = ativo.fields.map((f) => f.id);
    const de = ids.indexOf(String(active.id));
    const para = ids.indexOf(String(over.id));
    if (de < 0 || para < 0) return;
    onReordenar(ativo.id, arrayMove(ids, de, para));
  };

  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold">{ESCOPO_TITULOS[escopo]}</h4>

      {/* Abas de grupo — só o escopo do lead costuma ter mais de uma. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {grupos.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setGrupoAtivo(g.id)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs transition-colors',
              g.id === ativo.id
                ? 'border-primary bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {g.nome}
          </button>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onNovoGrupo(escopo)}
          title="Nova aba"
        >
          <Plus size={13} />
        </Button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={ativo.fields.map((f) => f.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-1.5">
            {ativo.fields.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                Nenhum campo nesta aba ainda.
              </p>
            ) : (
              ativo.fields.map((def) => (
                <SortableFieldRow
                  key={def.id}
                  def={def}
                  onEditar={() => onEditar(def)}
                  onAlternarVisivel={() => onAlternarVisivel(def)}
                  onRemover={() => onRemover(def)}
                />
              ))
            )}
          </div>
        </SortableContext>
      </DndContext>

      <Button variant="outline" size="sm" onClick={() => onNovoCampo(escopo, ativo.id)}>
        <Plus size={13} className="mr-1" /> Adicionar campo
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function FieldEditor() {
  const qc = useQueryClient();
  const [novoCampo, setNovoCampo] = useState<{ escopo: FieldScope; grupoId: string } | null>(null);
  const [editando, setEditando] = useState<FieldDef | null>(null);
  const [nome, setNome] = useState('');
  const [tipo, setTipo] = useState<FieldType>('text');
  const [opcoesRaw, setOpcoesRaw] = useState('');

  const { data: schema, isLoading } = useQuery<FieldSchema>({
    queryKey: ['custom-fields-schema'],
    queryFn: async () => (await api.get('/api/custom-fields/schema')).data,
  });

  const invalidar = () => {
    void qc.invalidateQueries({ queryKey: ['custom-fields-schema'] });
    void qc.invalidateQueries({ queryKey: ['custom-fields'] });
  };

  const criar = useMutation({
    mutationFn: async () => {
      const options = TIPOS_COM_OPCOES.includes(tipo)
        ? opcoesRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      await api.post('/api/custom-fields', {
        nome: nome.trim(),
        tipo,
        options,
        escopo: novoCampo?.escopo ?? 'LEAD',
        group_id: novoCampo?.grupoId,
      });
    },
    onSuccess: () => {
      invalidar();
      setNovoCampo(null);
      setNome('');
      setOpcoesRaw('');
      setTipo('text');
      toast.success('Campo criado');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao criar campo')),
  });

  const editar = useMutation({
    mutationFn: async () => {
      if (!editando) return;
      const body: Record<string, unknown> = { nome: nome.trim() };
      if (TIPOS_COM_OPCOES.includes(editando.tipo)) {
        body.options = opcoesRaw.split(',').map((s) => s.trim()).filter(Boolean);
      }
      await api.patch(`/api/custom-fields/${editando.id}`, body);
    },
    onSuccess: () => {
      invalidar();
      setEditando(null);
      // A `key` não muda no rename — nenhum valor já gravado se perde.
      toast.success('Campo atualizado');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao atualizar campo')),
  });

  const alternarVisivel = useMutation({
    mutationFn: async (def: FieldDef) =>
      api.patch(`/api/custom-fields/${def.id}`, { visible: !def.visible }),
    onSuccess: invalidar,
    onError: (e) => toast.error(erroDe(e, 'Erro ao alterar visibilidade')),
  });

  const remover = useMutation({
    mutationFn: async (def: FieldDef) => api.delete(`/api/custom-fields/${def.id}`),
    onSuccess: () => {
      invalidar();
      toast.success('Campo removido — valores já preenchidos são preservados');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao remover campo')),
  });

  const reordenar = useMutation({
    // O backend recebe a posição final de cada campo, não um swap: a lista
    // inteira vai com `ordem` reindexada a partir de 0.
    mutationFn: async ({ grupoId, ids }: { grupoId: string; ids: string[] }) =>
      api.post(
        '/api/custom-fields/reorder',
        ids.map((id, i) => ({ id, group_id: grupoId, ordem: i })),
      ),
    onSuccess: invalidar,
    onError: (e) => toast.error(erroDe(e, 'Erro ao reordenar')),
  });

  const criarGrupo = useMutation({
    mutationFn: async ({ escopo, nome: n }: { escopo: FieldScope; nome: string }) =>
      api.post('/api/custom-field-groups', { escopo, nome: n }),
    onSuccess: () => {
      invalidar();
      toast.success('Aba criada');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao criar aba')),
  });

  if (isLoading || !schema) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  const abrirNovoGrupo = (escopo: FieldScope) => {
    const n = window.prompt('Nome da nova aba');
    if (n?.trim()) criarGrupo.mutate({ escopo, nome: n.trim() });
  };

  const abrirEdicao = (def: FieldDef) => {
    setEditando(def);
    setNome(def.nome);
    setOpcoesRaw((def.options ?? []).join(', '));
  };

  const escopos: FieldScope[] = ['LEAD', 'CONTATO', 'EMPRESA'];

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground">
        Estes campos valem para todos os registros da empresa. Renomear preserva os valores já
        preenchidos; esconder também. Campos com cadeado são nativos do CRM e não podem ser
        removidos.
      </p>

      {escopos.map((escopo) => (
        <BlocoEscopo
          key={escopo}
          escopo={escopo}
          grupos={groupFields(schema, escopo, { incluirOcultos: true })}
          onReordenar={(grupoId, ids) => reordenar.mutate({ grupoId, ids })}
          onNovoCampo={(esc, grupoId) => {
            setNovoCampo({ escopo: esc, grupoId });
            setNome('');
            setTipo('text');
            setOpcoesRaw('');
          }}
          onNovoGrupo={abrirNovoGrupo}
          onEditar={abrirEdicao}
          onAlternarVisivel={(def) => alternarVisivel.mutate(def)}
          onRemover={(def) => remover.mutate(def)}
        />
      ))}

      {/* Novo campo */}
      <Dialog open={!!novoCampo} onOpenChange={(o) => !o && setNovoCampo(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Novo campo — {novoCampo ? ESCOPO_TITULOS[novoCampo.escopo].toLowerCase() : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cf-nome">Nome do campo</Label>
              <Input
                id="cf-nome"
                value={nome}
                maxLength={60}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Ex.: Origem da indicação"
              />
            </div>
            <div className="space-y-2">
              <Label>Tipo</Label>
              <Select value={tipo} onValueChange={(v) => setTipo(v as FieldType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TIPO_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {TIPOS_COM_OPCOES.includes(tipo) && (
              <div className="space-y-2">
                <Label htmlFor="cf-opts">Opções (separadas por vírgula)</Label>
                <Input
                  id="cf-opts"
                  value={opcoesRaw}
                  onChange={(e) => setOpcoesRaw(e.target.value)}
                  placeholder="Ex.: Instagram, Indicação, Site"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNovoCampo(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => criar.mutate()}
              disabled={
                !nome.trim() ||
                criar.isPending ||
                (TIPOS_COM_OPCOES.includes(tipo) && !opcoesRaw.trim())
              }
            >
              {criar.isPending ? 'Criando…' : 'Criar campo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editar campo */}
      <Dialog open={!!editando} onOpenChange={(o) => !o && setEditando(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar campo</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cf-edit-nome">Nome do campo</Label>
              <Input
                id="cf-edit-nome"
                value={nome}
                maxLength={60}
                onChange={(e) => setNome(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                O tipo não pode ser alterado — mudaria o significado dos valores já gravados.
              </p>
            </div>
            {editando && TIPOS_COM_OPCOES.includes(editando.tipo) && (
              <div className="space-y-2">
                <Label htmlFor="cf-edit-opts">Opções (separadas por vírgula)</Label>
                <Input
                  id="cf-edit-opts"
                  value={opcoesRaw}
                  onChange={(e) => setOpcoesRaw(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditando(null)}>
              Cancelar
            </Button>
            <Button onClick={() => editar.mutate()} disabled={!nome.trim() || editar.isPending}>
              {editar.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
