'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, GitMerge, Phone, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface DupLead {
  id: string;
  nome: string;
  telefone: string;
  email: string | null;
  foto_url: string | null;
  valor_estimado: string | null;
  created_at: string;
  ultima_interacao: string | null;
  responsavel: { id: string; nome: string } | null;
  estagio: { id: string; nome: string; cor: string } | null;
  _count: { messages: number };
}

interface DupGroup {
  criterio: 'telefone' | 'email';
  chave: string;
  leads: DupLead[];
}

function getInitials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString('pt-BR') : '—';
}

export function DuplicatesTab() {
  const queryClient = useQueryClient();
  // Confirmação de merge: par escolhido (target absorve source).
  const [mergePair, setMergePair] = useState<{ target: DupLead; source: DupLead } | null>(null);

  const { data, isLoading, refetch } = useQuery<{ groups: DupGroup[] }>({
    queryKey: ['lead-duplicates'],
    queryFn: async () => (await api.get('/api/leads/duplicates')).data,
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ target, source }: { target: DupLead; source: DupLead }) =>
      api.post(`/api/leads/${target.id}/merge`, { source_id: source.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead-duplicates'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setMergePair(null);
      toast.success('Leads mesclados — histórico preservado');
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? 'Erro ao mesclar'),
  });

  const groups = data?.groups ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Copy size={16} /> Leads duplicados
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Mesmo telefone (últimos 8 dígitos) ou mesmo e-mail. Mesclar move mensagens,
            atividades, tarefas e tags pro lead principal e apaga o duplicado.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Reescanear
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Escaneando…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed rounded-md p-6 text-center">
          Nenhum duplicado encontrado 🎉
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={`${g.criterio}-${g.chave}`} className="rounded-md border">
              <div className="px-4 py-2 border-b bg-muted/40 flex items-center gap-2 text-xs text-muted-foreground">
                {g.criterio === 'telefone' ? <Phone size={12} /> : <Mail size={12} />}
                <span>
                  {g.criterio === 'telefone' ? 'Telefone terminando em ' : 'E-mail '}
                  <strong>{g.chave}</strong> · {g.leads.length} leads
                </span>
              </div>
              <ul className="divide-y divide-border">
                {g.leads.map((l, idx) => (
                  <li key={l.id} className="flex items-center gap-3 px-4 py-3">
                    <Avatar className="h-8 w-8 shrink-0">
                      {l.foto_url && <AvatarImage src={l.foto_url} alt={l.nome} />}
                      <AvatarFallback>{getInitials(l.nome)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{l.nome}</span>
                        {l.estagio && (
                          <Badge
                            variant="outline"
                            style={{ borderColor: l.estagio.cor, color: l.estagio.cor }}
                          >
                            {l.estagio.nome}
                          </Badge>
                        )}
                        {idx === 0 && (
                          <Badge variant="outline" className="text-emerald-500 border-emerald-500/40">
                            mais antigo
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {l.telefone} · {l._count.messages} msgs · criado {fmtDate(l.created_at)}
                        {l.responsavel ? ` · ${l.responsavel.nome}` : ' · sem responsável'}
                      </p>
                    </div>
                    {idx > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setMergePair({ target: g.leads[0], source: l })}
                      >
                        <GitMerge size={14} className="mr-1" /> Mesclar no 1º
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!mergePair} onOpenChange={(o) => !o && setMergePair(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmar mesclagem</DialogTitle>
          </DialogHeader>
          {mergePair && (
            <div className="space-y-2 text-sm">
              <p>
                <strong>{mergePair.source.nome}</strong> ({mergePair.source._count.messages}{' '}
                msgs) será mesclado em <strong>{mergePair.target.nome}</strong> (
                {mergePair.target._count.messages} msgs).
              </p>
              <p className="text-xs text-muted-foreground">
                Mensagens, atividades, tarefas e tags são movidas. O lead duplicado é
                apagado. Essa ação não pode ser desfeita.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergePair(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={mergeMutation.isPending}
              onClick={() => mergePair && mergeMutation.mutate(mergePair)}
            >
              {mergeMutation.isPending ? 'Mesclando…' : 'Mesclar leads'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
