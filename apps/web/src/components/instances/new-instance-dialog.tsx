'use client';

import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (nome: string) => void;
  isPending?: boolean;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

export function NewInstanceDialog({ open, onOpenChange, onSubmit, isPending }: Props) {
  const [name, setName] = useState('');
  const slug = slugify(name);
  const valid = slug.length >= 2;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || isPending) return;
    onSubmit(slug);
    setName('');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setName('');
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nova Instância WhatsApp</DialogTitle>
          <DialogDescription>
            Escolha um nome único para identificar esta conexão. Use apenas letras minúsculas, números e hífens.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="instance-name">Nome da instância</Label>
            <Input
              id="instance-name"
              autoFocus
              placeholder="atendimento-01"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {name && (
              <p className="text-xs text-muted-foreground">
                Identificador: <span className="font-mono">{slug || '(inválido)'}</span>
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!valid || isPending}>
              {isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1.5 h-3.5 w-3.5" />
              )}
              Criar instância
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
