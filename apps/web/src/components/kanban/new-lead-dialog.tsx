'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { Stage } from './stage-column';
import type { Temperatura } from './lead-card';
import { TEMP_LABELS } from './lead-card';

export interface NewLeadFormData {
  nome: string;
  telefone: string;
  email?: string;
  estagio_id: string;
  temperatura: Temperatura;
}

interface NewLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: Stage[];
  defaultStageId?: string | null;
  isLoading?: boolean;
  onSubmit: (data: NewLeadFormData) => void;
}

const TEMP_OPTIONS: Temperatura[] = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'];

export function NewLeadDialog({
  open,
  onOpenChange,
  stages,
  defaultStageId,
  isLoading,
  onSubmit,
}: NewLeadDialogProps) {
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [email, setEmail] = useState('');
  const [stageId, setStageId] = useState<string>('');
  const [temperatura, setTemperatura] = useState<Temperatura>('FRIO');

  useEffect(() => {
    if (open) {
      setNome('');
      setTelefone('');
      setEmail('');
      setStageId(defaultStageId ?? stages[0]?.id ?? '');
      setTemperatura('FRIO');
    }
  }, [open, defaultStageId, stages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nome.trim() || !telefone.trim() || !stageId) return;
    onSubmit({
      nome: nome.trim(),
      telefone: telefone.trim(),
      email: email.trim() || undefined,
      estagio_id: stageId,
      temperatura,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo Lead</DialogTitle>
          <DialogDescription>Adicione um novo lead ao pipeline.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nome">Nome *</Label>
            <Input
              id="nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome do lead"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="telefone">Telefone *</Label>
            <Input
              id="telefone"
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              placeholder="+55 31 99999-9999"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="opcional"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Estágio</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Temperatura</Label>
              <Select
                value={temperatura}
                onValueChange={(v) => setTemperatura(v as Temperatura)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMP_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TEMP_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Criando...' : 'Criar Lead'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
