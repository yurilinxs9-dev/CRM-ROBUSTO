'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface PipelineLite {
  id: string;
  nome: string;
  cor?: string | null;
}

interface DeleteWithMoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string | null;
  pipelines: PipelineLite[];
  isLoading?: boolean;
  onSubmit: (targetPipelineId: string) => void;
}

export function DeleteWithMoveDialog({
  open,
  onOpenChange,
  sourceId,
  pipelines,
  isLoading,
  onSubmit,
}: DeleteWithMoveDialogProps) {
  const targets = pipelines.filter((p) => p.id !== sourceId);
  const [target, setTarget] = useState<string>('');

  useEffect(() => {
    if (open) setTarget(targets[0]?.id ?? '');
  }, [open, targets]);

  const source = pipelines.find((p) => p.id === sourceId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Excluir funil</DialogTitle>
          <DialogDescription>
            {source ? (
              <>
                Os leads do funil{' '}
                <span className="font-semibold text-foreground">{source.nome}</span> serao
                movidos para o funil escolhido abaixo. Esta acao nao pode ser desfeita.
              </>
            ) : (
              'Selecione o funil de destino para os leads.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Mover leads para</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger>
              <SelectValue placeholder="Selecione o funil de destino" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <div className="flex items-center gap-2">
                    {p.cor && (
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: p.cor }}
                      />
                    )}
                    {p.nome}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {targets.length === 0 && (
            <p className="text-xs text-destructive">
              Nenhum outro funil disponivel. Crie um funil antes de excluir este.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => target && onSubmit(target)}
            disabled={isLoading || !target}
          >
            {isLoading ? 'Movendo...' : 'Mover e excluir'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
