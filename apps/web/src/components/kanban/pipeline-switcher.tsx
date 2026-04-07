'use client';

import { memo, useState } from 'react';
import { MoreVertical, Plus, Pencil, Copy, Archive, Trash2, Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface PipelineSummary {
  id: string;
  nome: string;
  cor?: string | null;
  arquivado?: boolean;
}

interface PipelineSwitcherProps {
  pipelines: PipelineSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, nome: string) => void;
  onDuplicate: (id: string) => void;
  onArchive: (id: string) => void;
  onDeleteWithMove: (id: string) => void;
}

function PipelineSwitcherImpl({
  pipelines,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDuplicate,
  onArchive,
  onDeleteWithMove,
}: PipelineSwitcherProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startRename = (p: PipelineSummary) => {
    setEditingId(p.id);
    setDraft(p.nome);
  };

  const commitRename = () => {
    if (editingId && draft.trim()) {
      onRename(editingId, draft.trim());
    }
    setEditingId(null);
    setDraft('');
  };

  const cancelRename = () => {
    setEditingId(null);
    setDraft('');
  };

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {pipelines.map((p) => {
        const isActive = p.id === activeId;
        const isEditing = editingId === p.id;
        return (
          <div
            key={p.id}
            className={cn(
              'group flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors',
              isActive
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-transparent hover:bg-accent',
            )}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: p.cor ?? '#3b82f6' }}
              aria-hidden
            />
            {isEditing ? (
              <>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') cancelRename();
                  }}
                  autoFocus
                  className="h-6 w-32 px-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={commitRename}
                  className="rounded p-0.5 text-emerald-500 hover:bg-emerald-500/10"
                  aria-label="Salvar"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={cancelRename}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                  aria-label="Cancelar"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onSelect(p.id)}
                  className="font-medium"
                >
                  {p.nome}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 data-[state=open]:opacity-100"
                      aria-label="Opcoes do funil"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => startRename(p)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Renomear
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onDuplicate(p.id)}>
                      <Copy className="mr-2 h-3.5 w-3.5" />
                      Duplicar
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onArchive(p.id)}>
                      <Archive className="mr-2 h-3.5 w-3.5" />
                      Arquivar
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => onDeleteWithMove(p.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Excluir e mover leads
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs"
        onClick={onCreate}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Novo Funil
      </Button>
    </div>
  );
}

export const PipelineSwitcher = memo(PipelineSwitcherImpl);
