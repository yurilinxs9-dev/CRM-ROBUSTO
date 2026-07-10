'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ListChecks } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

export interface CustomFieldDef {
  id: string;
  nome: string;
  key: string;
  tipo: 'text' | 'number' | 'date' | 'select' | 'boolean';
  options: string[] | null;
  ordem: number;
  active: boolean;
}

const TIPO_LABELS: Record<string, string> = {
  text: 'Texto',
  number: 'Número',
  date: 'Data',
  select: 'Seleção',
  boolean: 'Sim/Não',
};

export function CustomFieldsTab() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState('');
  const [tipo, setTipo] = useState<CustomFieldDef['tipo']>('text');
  const [optionsRaw, setOptionsRaw] = useState('');

  const { data: fields = [], isLoading } = useQuery<CustomFieldDef[]>({
    queryKey: ['custom-fields'],
    queryFn: async () => (await api.get('/api/custom-fields')).data,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const options =
        tipo === 'select'
          ? optionsRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      await api.post('/api/custom-fields', { nome: nome.trim(), tipo, options });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
      setOpen(false);
      setNome('');
      setOptionsRaw('');
      setTipo('text');
      toast.success('Campo criado');
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? 'Erro ao criar campo'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/custom-fields/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
      toast.success('Campo desativado — valores já preenchidos são preservados');
    },
    onError: () => toast.error('Erro ao desativar campo'),
  });

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ListChecks size={16} /> Campos customizados do lead
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Aparecem na ficha do lead (kanban e chat). Desativar não apaga valores já
            preenchidos.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus size={14} className="mr-1" /> Novo campo
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : fields.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed rounded-md p-6 text-center">
          Nenhum campo customizado ainda. Crie o primeiro — ex.: “Origem da indicação”,
          “Data de aniversário”, “Plano de interesse”.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border">
          {fields.map((f) => (
            <li key={f.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <span className="text-sm font-medium">{f.nome}</span>
                <span className="ml-2 text-xs text-muted-foreground">({f.key})</span>
                {f.tipo === 'select' && f.options?.length ? (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {f.options.join(' · ')}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="outline">{TIPO_LABELS[f.tipo] ?? f.tipo}</Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => deleteMutation.mutate(f.id)}
                  title="Desativar campo"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Novo campo customizado</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cf-nome">Nome do campo</Label>
              <Input
                id="cf-nome"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Ex.: Origem da indicação"
                maxLength={60}
              />
            </div>
            <div className="space-y-2">
              <Label>Tipo</Label>
              <Select value={tipo} onValueChange={(v) => setTipo(v as CustomFieldDef['tipo'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TIPO_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {tipo === 'select' && (
              <div className="space-y-2">
                <Label htmlFor="cf-options">Opções (separadas por vírgula)</Label>
                <Input
                  id="cf-options"
                  value={optionsRaw}
                  onChange={(e) => setOptionsRaw(e.target.value)}
                  placeholder="Ex.: Instagram, Indicação, Site"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={
                !nome.trim() ||
                createMutation.isPending ||
                (tipo === 'select' && !optionsRaw.trim())
              }
            >
              {createMutation.isPending ? 'Criando…' : 'Criar campo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
