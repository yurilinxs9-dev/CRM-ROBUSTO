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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type QuickTaskTipo = 'FOLLOW_UP' | 'LIGACAO' | 'REUNIAO' | 'EMAIL' | 'VISITA' | 'OUTRO';

const TIPOS: { value: QuickTaskTipo; label: string }[] = [
  { value: 'FOLLOW_UP', label: 'Follow-up' },
  { value: 'LIGACAO', label: 'Ligacao' },
  { value: 'REUNIAO', label: 'Reuniao' },
  { value: 'EMAIL', label: 'E-mail' },
  { value: 'VISITA', label: 'Visita' },
  { value: 'OUTRO', label: 'Outro' },
];

export interface QuickTaskFormData {
  titulo: string;
  tipo: QuickTaskTipo;
  scheduled_at: string;
}

interface QuickTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading?: boolean;
  onSubmit: (data: QuickTaskFormData) => void;
}

function defaultDate(): string {
  // Local "yyyy-MM-ddTHH:mm" string for tomorrow 09:00.
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function QuickTaskDialog({
  open,
  onOpenChange,
  isLoading,
  onSubmit,
}: QuickTaskDialogProps) {
  const [titulo, setTitulo] = useState('');
  const [tipo, setTipo] = useState<QuickTaskTipo>('FOLLOW_UP');
  const [when, setWhen] = useState<string>(defaultDate());

  useEffect(() => {
    if (open) {
      setTitulo('');
      setTipo('FOLLOW_UP');
      setWhen(defaultDate());
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova tarefa</DialogTitle>
          <DialogDescription>
            Crie uma tarefa rapida vinculada a este lead.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = titulo.trim();
            if (!t || !when) return;
            onSubmit({
              titulo: t,
              tipo,
              scheduled_at: new Date(when).toISOString(),
            });
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="task-titulo">Titulo *</Label>
            <Input
              id="task-titulo"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="Ex.: Ligar para confirmar reuniao"
              autoFocus
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-tipo">Tipo</Label>
              <Select value={tipo} onValueChange={(v) => setTipo(v as QuickTaskTipo)}>
                <SelectTrigger id="task-tipo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIPOS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-when">Quando *</Label>
              <Input
                id="task-when"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                required
              />
            </div>
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
            <Button type="submit" disabled={isLoading || !titulo.trim()}>
              {isLoading ? 'Salvando...' : 'Criar tarefa'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
