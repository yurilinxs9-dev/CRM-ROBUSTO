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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ColorPicker } from './color-picker';

interface NewPipelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading?: boolean;
  onSubmit: (data: { nome: string; cor: string }) => void;
}

export function NewPipelineDialog({
  open,
  onOpenChange,
  isLoading,
  onSubmit,
}: NewPipelineDialogProps) {
  const [nome, setNome] = useState('');
  const [cor, setCor] = useState('#3b82f6');

  useEffect(() => {
    if (open) {
      setNome('');
      setCor('#3b82f6');
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo Funil</DialogTitle>
          <DialogDescription>
            Crie um novo funil de vendas. Etapas padrao serao adicionadas automaticamente.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!nome.trim()) return;
            onSubmit({ nome: nome.trim(), cor });
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="pipeline-nome">Nome *</Label>
            <Input
              id="pipeline-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex.: Vendas B2B"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Cor</Label>
            <ColorPicker value={cor} onChange={setCor}>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent"
              >
                <span
                  className="h-4 w-4 rounded-full border border-border"
                  style={{ backgroundColor: cor }}
                />
                <span className="font-mono text-xs">{cor}</span>
              </button>
            </ColorPicker>
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
            <Button type="submit" disabled={isLoading || !nome.trim()}>
              {isLoading ? 'Criando...' : 'Criar Funil'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
