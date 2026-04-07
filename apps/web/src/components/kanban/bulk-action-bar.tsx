'use client';

import { useState } from 'react';
import { useMutation, type QueryClient } from '@tanstack/react-query';
import { X, ChevronDown, Tag, UserCheck, MoveRight, Archive } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';
import type { Stage } from './stage-column';

interface TenantUser {
  id: string;
  nome: string;
  email: string;
  role: string;
}

interface BulkActionBarProps {
  selectedCount: number;
  selectedIds: string[];
  stages: Stage[];
  users: TenantUser[];
  onClear: () => void;
  activePipelineId: string;
  queryClient: QueryClient;
}

export function BulkActionBar({
  selectedCount,
  selectedIds,
  stages,
  users,
  onClear,
  activePipelineId,
  queryClient,
}: BulkActionBarProps) {
  const [tagInput, setTagInput] = useState('');
  const [tagOpen, setTagOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['leads', activePipelineId] });
  };

  const moveStageMutation = useMutation({
    mutationFn: async (estagio_id: string) => {
      const res = await api.post('/api/leads/bulk/move-stage', { ids: selectedIds, estagio_id });
      return res.data as { updated: number };
    },
    onSuccess: (data) => {
      invalidate();
      onClear();
      toast.success(`${data.updated} lead(s) movido(s).`);
    },
    onError: () => toast.error('Erro ao mover leads.'),
  });

  const assignMutation = useMutation({
    mutationFn: async (responsavel_id: string) => {
      const res = await api.post('/api/leads/bulk/assign', { ids: selectedIds, responsavel_id });
      return res.data as { updated: number };
    },
    onSuccess: (data) => {
      invalidate();
      onClear();
      toast.success(`${data.updated} lead(s) atribuido(s).`);
    },
    onError: () => toast.error('Erro ao atribuir leads.'),
  });

  const tagMutation = useMutation({
    mutationFn: async (tag: string) => {
      const res = await api.post('/api/leads/bulk/tag', { ids: selectedIds, tag });
      return res.data as { updated: number };
    },
    onSuccess: (data) => {
      invalidate();
      onClear();
      toast.success(`Tag adicionada a ${data.updated} lead(s).`);
    },
    onError: () => toast.error('Erro ao adicionar tag.'),
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/leads/bulk/archive', { ids: selectedIds });
      return res.data as { archived: number };
    },
    onSuccess: (data) => {
      invalidate();
      onClear();
      toast.success(`${data.archived} lead(s) arquivado(s).`);
    },
    onError: () => toast.error('Erro ao arquivar leads.'),
  });

  const isPending =
    moveStageMutation.isPending ||
    assignMutation.isPending ||
    tagMutation.isPending ||
    archiveMutation.isPending;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl border bg-background px-4 py-2.5 shadow-2xl ring-1 ring-border animate-in slide-in-from-bottom-4 duration-200">
      <span className="text-sm font-medium tabular-nums mr-1">
        {selectedCount} lead{selectedCount !== 1 ? 's' : ''} selecionado{selectedCount !== 1 ? 's' : ''}
      </span>

      {/* Move to stage */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={isPending} className="h-7 gap-1 text-xs">
            <MoveRight className="h-3.5 w-3.5" />
            Mover etapa
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-[160px]">
          {stages.map((stage) => (
            <DropdownMenuItem
              key={stage.id}
              onClick={() => moveStageMutation.mutate(stage.id)}
            >
              <span
                className="mr-2 inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: stage.cor }}
              />
              {stage.nome}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Assign user */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={isPending} className="h-7 gap-1 text-xs">
            <UserCheck className="h-3.5 w-3.5" />
            Atribuir
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-[160px]">
          {users.map((user) => (
            <DropdownMenuItem key={user.id} onClick={() => assignMutation.mutate(user.id)}>
              {user.nome}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Add tag */}
      <DropdownMenu open={tagOpen} onOpenChange={setTagOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={isPending} className="h-7 gap-1 text-xs">
            <Tag className="h-3.5 w-3.5" />
            Tag
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="p-2 w-52">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const val = tagInput.trim();
              if (!val) return;
              tagMutation.mutate(val);
              setTagInput('');
              setTagOpen(false);
            }}
            className="flex gap-1.5"
          >
            <Input
              autoFocus
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="Nome da tag..."
              className="h-7 text-xs"
              maxLength={50}
            />
            <Button type="submit" size="sm" className="h-7 text-xs" disabled={!tagInput.trim()}>
              OK
            </Button>
          </form>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Archive */}
      <DropdownMenu open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            className={cn('h-7 gap-1 text-xs text-destructive hover:text-destructive')}
          >
            <Archive className="h-3.5 w-3.5" />
            Arquivar
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="p-3 w-52">
          <p className="text-xs text-muted-foreground mb-2">
            Arquivar {selectedCount} lead{selectedCount !== 1 ? 's' : ''}? Esta acao nao pode ser desfeita.
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="destructive"
              className="h-7 flex-1 text-xs"
              disabled={archiveMutation.isPending}
              onClick={() => {
                archiveMutation.mutate();
                setArchiveOpen(false);
              }}
            >
              Confirmar
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setArchiveOpen(false)}
            >
              Cancelar
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Clear */}
      <button
        type="button"
        onClick={onClear}
        className="ml-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Cancelar selecao"
        aria-label="Cancelar selecao"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
