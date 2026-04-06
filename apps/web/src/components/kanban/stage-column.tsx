'use client';

import { useDroppable } from '@dnd-kit/core';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LeadCard, formatBRL, type Lead } from './lead-card';
import { cn } from '@/lib/cn';

export interface Stage {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
}

function SortableLead({
  lead,
  onClick,
}: {
  lead: Lead;
  onClick: () => void;
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
      <LeadCard lead={lead} />
    </div>
  );
}

interface StageColumnProps {
  stage: Stage;
  leads: Lead[];
  onClickLead: (leadId: string) => void;
  onAddLead: (stageId: string) => void;
}

export function StageColumn({ stage, leads, onClickLead, onAddLead }: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${stage.id}`,
    data: { type: 'column', stageId: stage.id },
  });

  const total = leads.reduce((sum, l) => sum + (Number(l.valor_estimado) || 0), 0);

  return (
    <div className="flex-shrink-0 w-80 flex flex-col h-full bg-muted/30 rounded-lg border">
      {/* Header */}
      <div className="sticky top-0 z-10 px-3 py-2.5 border-b bg-muted/50 backdrop-blur rounded-t-lg">
        <div className="flex items-center gap-2">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: stage.cor }}
            aria-hidden
          />
          <span className="text-sm font-semibold truncate flex-1">{stage.nome}</span>
          <span className="text-xs text-muted-foreground tabular-nums">({leads.length})</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onAddLead(stage.id)}
            title="Adicionar lead"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
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
          ref={setNodeRef}
          className={cn(
            'p-2 space-y-2 min-h-[200px] transition-colors',
            isOver && 'bg-primary/5'
          )}
        >
          <SortableContext items={leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            {leads.map((lead) => (
              <SortableLead
                key={lead.id}
                lead={lead}
                onClick={() => onClickLead(lead.id)}
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
        className="px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 border-t transition-colors text-left rounded-b-lg"
      >
        + Adicionar lead
      </button>
    </div>
  );
}
