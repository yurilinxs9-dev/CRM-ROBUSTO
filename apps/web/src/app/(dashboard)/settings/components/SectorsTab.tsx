'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Check, X, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useSectors } from '@/hooks/use-sectors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * F-01 — Gerenciamento de setores (admin do tenant). Criar, renomear e
 * desativar (soft delete: some do dropdown mas preserva o histórico dos
 * usuários vinculados).
 */
export function SectorsTab() {
  const qc = useQueryClient();
  const { data: sectors = [], isLoading } = useSectors(true);
  const [newName, setNewName] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['sectors'] });
    qc.invalidateQueries({ queryKey: ['team'] });
  };
  const onErr = (e: unknown) =>
    toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Erro');

  const createM = useMutation({
    mutationFn: async () => api.post('/api/sectors', { name: newName.trim() }),
    onSuccess: () => { toast.success('Setor criado'); setNewName(''); invalidate(); },
    onError: onErr,
  });
  const updateM = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => api.put(`/api/sectors/${id}`, { name }),
    onSuccess: () => { toast.success('Setor atualizado'); setEditId(null); invalidate(); },
    onError: onErr,
  });
  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/sectors/${id}`),
    onSuccess: () => { toast.success('Setor desativado'); invalidate(); },
    onError: onErr,
  });

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">
        Organize a equipe em setores (opcional). Setores desativados somem dos formulários
        mas o histórico dos usuários é preservado.
      </p>

      <div className="flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nome do novo setor (ex: Vendas, Suporte)"
          onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) createM.mutate(); }}
        />
        <Button onClick={() => createM.mutate()} disabled={createM.isPending || !newName.trim()}>
          <Plus className="h-4 w-4 mr-1" /> Criar
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded-lg border bg-muted/20 animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-2">
          {sectors.map((s) => (
            <div key={s.id} className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 ${!s.active ? 'opacity-50' : ''}`}>
              {editId === s.id ? (
                <>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8 flex-1" autoFocus />
                  <Button size="icon" variant="ghost" className="h-7 w-7" disabled={updateM.isPending || !editName.trim()}
                    onClick={() => updateM.mutate({ id: s.id, name: editName.trim() })}>
                    <Check className="h-4 w-4 text-emerald-500" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditId(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{s.name}</span>
                    {!s.active && <span className="ml-2 text-xs text-muted-foreground">(inativo)</span>}
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" /> {s._count?.users ?? 0}
                  </span>
                  {s.active && (
                    <>
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Renomear"
                        onClick={() => { setEditId(s.id); setEditName(s.name); }}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Desativar"
                        disabled={deleteM.isPending}
                        onClick={() => { if (confirm(`Desativar o setor "${s.name}"?`)) deleteM.mutate(s.id); }}>
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          ))}
          {sectors.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">Nenhum setor ainda.</p>}
        </div>
      )}
    </div>
  );
}
