'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface NewChatFormData {
  nome: string;
  telefone: string;
  estagio_id: string;
  pipeline_id: string;
}

export interface Stage {
  id: string;
  nome: string;
  ordem: number;
}

export interface Pipeline {
  id: string;
  nome: string;
  stages: Stage[];
}

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelines: Pipeline[];
  isLoading?: boolean;
  onSubmit: (data: NewChatFormData) => void;
}

// E.164 validation (international phone format)
const E164_REGEX = /^\+?[1-9]\d{7,14}$/;

function normalizeE164(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  return trimmed.startsWith('+') ? `+${digits}` : `+${digits}`;
}

export function NewChatDialog({
  open,
  onOpenChange,
  pipelines,
  isLoading,
  onSubmit,
}: NewChatDialogProps) {
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [stageId, setStageId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Grouped by pipeline (stable pipeline order = order in the `pipelines` prop),
  // stages ordered by `ordem` within each group. Pipelines without stages are
  // skipped — an empty group heading would be pure noise.
  const groupedStages = useMemo(() => {
    return pipelines
      .filter((p) => p.stages.length > 0)
      .map((p) => ({
        pipelineId: p.id,
        pipelineNome: p.nome,
        stages: [...p.stages].sort((a, b) => a.ordem - b.ordem),
      }));
  }, [pipelines]);

  const stageToPipelineId = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groupedStages) {
      for (const s of group.stages) {
        map.set(s.id, group.pipelineId);
      }
    }
    return map;
  }, [groupedStages]);

  const hasMultiplePipelines = groupedStages.length > 1;
  const totalStageCount = groupedStages.reduce((acc, g) => acc + g.stages.length, 0);
  const firstStageId = groupedStages[0]?.stages[0]?.id ?? '';

  useEffect(() => {
    if (open) {
      setNome('');
      setTelefone('');
      setStageId(firstStageId);
      setError(null);
    }
  }, [open, firstStageId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!nome.trim()) {
      setError('Nome é obrigatório');
      return;
    }
    if (!stageId) {
      setError('Selecione um estágio');
      return;
    }

    const normalized = normalizeE164(telefone);
    if (!E164_REGEX.test(normalized)) {
      setError('Telefone inválido. Use formato internacional, ex: +5531999999999');
      return;
    }

    onSubmit({
      nome: nome.trim(),
      telefone: normalized,
      estagio_id: stageId,
      pipeline_id: stageToPipelineId.get(stageId) ?? '',
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova conversa</DialogTitle>
          <DialogDescription>
            Crie um novo lead para iniciar uma conversa de WhatsApp.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="chat-nome">Nome *</Label>
            <Input
              id="chat-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome do contato"
              autoFocus
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="chat-telefone">Telefone *</Label>
            <Input
              id="chat-telefone"
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              placeholder="+55 31 99999-9999"
              inputMode="tel"
              required
            />
            <p className="text-[11px] text-muted-foreground">
              Formato internacional E.164
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Estágio</Label>
            <Select value={stageId} onValueChange={setStageId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione um estágio" />
              </SelectTrigger>
              <SelectContent>
                {hasMultiplePipelines
                  ? groupedStages.map((group) => (
                      <SelectGroup key={group.pipelineId}>
                        <SelectLabel className="text-ink-3">{group.pipelineNome}</SelectLabel>
                        {group.stages.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.nome}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))
                  : groupedStages[0]?.stages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.nome}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </div>

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isLoading || totalStageCount === 0}>
              {isLoading ? 'Criando...' : 'Criar conversa'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
