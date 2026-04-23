'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Shield, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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

interface TeamMember {
  id: string;
  nome: string;
  email: string;
  role: string;
  ativo: boolean;
  avatar_url?: string | null;
  titulo?: string | null;
  especialidade?: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  GERENTE: 'Gerente',
  OPERADOR: 'Operador',
  VISUALIZADOR: 'Visualizador',
};

const ROLE_BADGE: Record<string, string> = {
  SUPER_ADMIN: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  GERENTE: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  OPERADOR: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  VISUALIZADOR: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

function getInitials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export function TeamTab() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [newNome, setNewNome] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newSenha, setNewSenha] = useState('');
  const [newRole, setNewRole] = useState<'GERENTE' | 'OPERADOR' | 'VISUALIZADOR'>('OPERADOR');

  const { data: members = [], isLoading } = useQuery<TeamMember[]>({
    queryKey: ['team'],
    queryFn: async () => {
      const res = await api.get('/api/users/team');
      return res.data as TeamMember[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await api.post('/api/users/team', { nome: newNome, email: newEmail, senha: newSenha, role: newRole });
    },
    onSuccess: () => {
      toast.success('Membro adicionado!');
      queryClient.invalidateQueries({ queryKey: ['team'] });
      setAddOpen(false);
      setNewNome(''); setNewEmail(''); setNewSenha(''); setNewRole('OPERADOR');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? 'Erro ao adicionar membro.');
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      await api.patch(`/api/users/team/${id}`, data);
    },
    onSuccess: () => {
      toast.success('Membro atualizado!');
      queryClient.invalidateQueries({ queryKey: ['team'] });
    },
    onError: () => toast.error('Erro ao atualizar membro.'),
  });

  const toggleAtivo = (m: TeamMember) => {
    updateMutation.mutate({ id: m.id, data: { ativo: !m.ativo } });
  };

  const changeRole = (m: TeamMember, role: string) => {
    updateMutation.mutate({ id: m.id, data: { role } });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{members.length} membro{members.length !== 1 ? 's' : ''}</p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Adicionar Membro
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg border bg-muted/20 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {members.map((m) => {
            const isSuperAdmin = m.role === 'SUPER_ADMIN';
            return (
              <div
                key={m.id}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${!m.ativo ? 'opacity-50' : ''}`}
              >
                <Avatar className="h-9 w-9 shrink-0">
                  {m.avatar_url && <AvatarImage src={m.avatar_url} alt={m.nome} />}
                  <AvatarFallback className="text-xs">{getInitials(m.nome)}</AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{m.nome}</p>
                  <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                  {m.especialidade && (
                    <p className="text-xs text-muted-foreground truncate">{m.especialidade}</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isSuperAdmin ? (
                    <Badge variant="outline" className={ROLE_BADGE['SUPER_ADMIN']}>
                      <Shield className="h-3 w-3 mr-1" />
                      {ROLE_LABELS['SUPER_ADMIN']}
                    </Badge>
                  ) : (
                    <Select
                      value={m.role}
                      onValueChange={(v) => changeRole(m, v)}
                      disabled={updateMutation.isPending}
                    >
                      <SelectTrigger className="h-7 w-36 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="GERENTE">Gerente</SelectItem>
                        <SelectItem value="OPERADOR">Operador</SelectItem>
                        <SelectItem value="VISUALIZADOR">Visualizador</SelectItem>
                      </SelectContent>
                    </Select>
                  )}

                  {!isSuperAdmin && (
                    <button
                      type="button"
                      title={m.ativo ? 'Desativar' : 'Ativar'}
                      onClick={() => toggleAtivo(m)}
                      className="rounded p-1 text-muted-foreground hover:bg-accent"
                      disabled={updateMutation.isPending}
                    >
                      {m.ativo ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4 text-emerald-500" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add member dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar Membro</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Nome</Label>
              <Input value={newNome} onChange={(e) => setNewNome(e.target.value)} placeholder="Nome completo" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="email@empresa.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Senha</Label>
              <Input type="password" value={newSenha} onChange={(e) => setNewSenha(e.target.value)} placeholder="mínimo 8 caracteres" />
            </div>
            <div className="space-y-1.5">
              <Label>Função</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as typeof newRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPERADOR">Operador</SelectItem>
                  <SelectItem value="GERENTE">Gerente</SelectItem>
                  <SelectItem value="VISUALIZADOR">Visualizador</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancelar</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !newNome.trim() || !newEmail.trim() || newSenha.length < 8}
            >
              {createMutation.isPending ? 'Adicionando...' : 'Adicionar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
