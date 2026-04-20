'use client';

import { memo, useState, type KeyboardEvent } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  useSortable,
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus,
  Inbox,
  MoreVertical,
  Pencil,
  Palette,
  Copy,
  Trash2,
  Settings,
  ArrowLeft,
  ArrowRight,
  GripVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LeadCard, formatBRL, type Lead } from './lead-card';
import { ColorPicker } from './color-picker';
import { cn } from '@/lib/cn';

export interface Stage {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
  is_won?: boolean;
  is_lost?: boolean;
  max_dias?: number | null;
  auto_action?: unknown;
  sla_config?: any;
  idle_alert_config?: any;
  on_entry_config?: any;
  cadence_config?: any;
}

function getSlaThresholdDays(stage: Stage): number | null {
  const sla = stage.sla_config as any;
  if (sla?.enabled && sla?.action === 'ALERT') {
    const d = Number(sla.duration);
    if (sla.unit === 'DAYS') return d;
    if (sla.unit === 'HOURS') return d / 24;
    if (sla.unit === 'MINUTES') return d / 1440;
  }
  return stage.max_dias ?? null;
}

function SortableLeadImpl({
  lead,
  stage,
  onClick,
  onOpenChat,
  onQuickTask,
  onArchiveLead,
  selected,
  onToggleSelect,
  showCheckbox,
}: {
  lead: Lead;
  stage: Stage;
  onClick: () => void;
  onOpenChat?: (leadId: string) => void;
  onQuickTask?: (leadId: string) => void;
  onArchiveLead?: (leadId: string) => void;
  onOpenDetail?: (leadId: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  showCheckbox?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: lead.id, data: { type: 'lead', lead } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={isDragging ? 'opacity-30' : ''}
    >
      <LeadCard
        lead={lead}
        stageMaxDias={getSlaThresholdDays(stage)}
        idleAlertConfig={stage.idle_alert_config}
        onOpenChat={onOpenChat}
        onQuickTask={onQuickTask}
        onArchiveLead={onArchiveLead}
        selected={selected}
        onToggleSelect={onToggleSelect}
        showCheckbox={showCheckbox}
      />
    </div>
  );
}

const SortableLead = memo(SortableLeadImpl);

interface StageColumnProps {
  stage: Stage;
  leads: Lead[];
  onClickLead: (leadId: string) => void;
  onAddLead: (stageId: string) => void;
  onRenameStage: (stageId: string, nome: string) => void;
  onChangeColor: (stageId: string, cor: string) => void;
  onDuplicateStage: (stageId: string) => void;
  onDeleteStage: (stageId: string) => void;
  onConfigureStage: (stageId: string) => void;
  onMoveStage: (stageId: string, dir: -1 | 1) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onQuickTaskLead?: (leadId: string) => void;
  onArchiveLead?: (leadId: string) => void;
  onOpenDetail?: (leadId: string) => void;
  selectedLeadIds?: Set<string>;
  onToggleSelect?: (leadId: string) => void;
  onSelectAllInStage?: (stageId: string) => void;
}

function StageColumnImpl({
  stage,
  leads,
  onClickLead,
  onAddLead,
  onRenameStage,
  onChangeColor,
  onDuplicateStage,
  onDeleteStage,
  onConfigureStage,
  onMoveStage,
  canMoveLeft,
  canMoveRight,
  onQuickTaskLead,
  onArchiveLead,
  onOpenDetail,
  selectedLeadIds,
  onToggleSelect,
  onSelectAllInStage,
}: StageColumnProps) {
  const bulkActive = selectedLeadIds !== undefined && selectedLeadIds.size > 0;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(stage.nome);

  const {
    setNodeRef: setSortableRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `stage-${stage.id}`, data: { type: 'stage', stageId: stage.id } });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `column-${stage.id}`,
    data: { type: 'column', stageId: stage.id },
  });

  const total = leads.reduce((sum, l) => sum + (Number(l.valor_estimado) || 0), 0);

  const startRename = () => {
    setDraft(stage.nome);
    setIsEditing(true);
  };
  const commitRename = () => {
    const v = draft.trim();
    if (v && v !== stage.nome) onRenameStage(stage.id, v);
    setIsEditing(false);
  };
  const cancelRename = () => {
    setDraft(stage.nome);
    setIsEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') cancelRename();
  };

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setSortableRef}
      style={sortableStyle}
      className="flex-shrink-0 w-80 flex flex-col h-full bg-muted/30 rounded-lg border overflow-hidden"
    >
      {/* Top accent border using stage color */}
      <div className="h-1 w-full" style={{ backgroundColor: stage.cor }} aria-hidden />

      {/* Header */}
      <div className="sticky top-0 z-10 px-3 py-2.5 border-b bg-muted/50 backdrop-blur">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab text-muted-foreground/60 hover:text-muted-foreground touch-none"
            aria-label="Reordenar etapa"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: stage.cor }}
            aria-hidden
          />
          {isEditing ? (
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={onKey}
              autoFocus
              className="h-6 flex-1 px-1.5 text-xs"
            />
          ) : (
            <button
              type="button"
              onDoubleClick={startRename}
              className="text-sm font-semibold truncate flex-1 text-left"
              title="Duplo clique para renomear"
            >
              {stage.nome}
            </button>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">({leads.length})</span>
          {bulkActive && onSelectAllInStage && leads.length > 0 && (
            <button
              type="button"
              onClick={() => onSelectAllInStage(stage.id)}
              className="rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Selecionar todos nesta etapa"
            >
              Sel. todos
            </button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onAddLead(stage.id)}
            title="Adicionar lead"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                aria-label="Opcoes da etapa"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={startRename}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                Renomear
              </DropdownMenuItem>
              <ColorPicker value={stage.cor} onChange={(c) => onChangeColor(stage.id, c)}>
                <button
                  type="button"
                  className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Palette className="mr-2 h-3.5 w-3.5" />
                  Mudar cor
                </button>
              </ColorPicker>
              <DropdownMenuItem onClick={() => onConfigureStage(stage.id)}>
                <Settings className="mr-2 h-3.5 w-3.5" />
                Configurar
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicateStage(stage.id)}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                Duplicar
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canMoveLeft}
                onClick={() => onMoveStage(stage.id, -1)}
              >
                <ArrowLeft className="mr-2 h-3.5 w-3.5" />
                Mover para esquerda
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canMoveRight}
                onClick={() => onMoveStage(stage.id, 1)}
              >
                <ArrowRight className="mr-2 h-3.5 w-3.5" />
                Mover para direita
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDeleteStage(stage.id)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Excluir
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {total > 0 && (
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
            {formatBRL(String(total))}
          </p>
        )}
      </div>

      {/* Body */}
      <ScrollArea className="flex-1">
        <div
          ref={setDropRef}
          className={cn(
            'p-2 space-y-2 min-h-[200px] transition-colors',
            isOver && 'bg-primary/5',
          )}
        >
          <SortableContext items={leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            {leads.map((lead) => (
              <SortableLead
                key={lead.id}
                lead={lead}
                stage={stage}
                onClick={() => onOpenDetail ? onOpenDetail(lead.id) : onClickLead(lead.id)}
                onOpenChat={onClickLead}
                onQuickTask={onQuickTaskLead}
                onArchiveLead={onArchiveLead}
                onOpenDetail={onOpenDetail}
                selected={selectedLeadIds?.has(lead.id)}
                onToggleSelect={onToggleSelect}
                showCheckbox={bulkActive}
              />
            ))}
          </SortableContext>

          {leads.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/60">
              <Inbox className="h-8 w-8 mb-2" />
              <p className="text-xs">Sem leads</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <button
        type="button"
        onClick={() => onAddLead(stage.id)}
        className="px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 border-t transition-colors text-left"
      >
        + Adicionar lead
      </button>
    </div>
  );
}

export const StageColumn = memo(StageColumnImpl);
