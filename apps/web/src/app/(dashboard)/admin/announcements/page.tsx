'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Send, Power } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

interface Announcement {
  id: string; title: string; body: string; level: 'INFO' | 'WARNING' | 'MAINTENANCE'; active: boolean; created_at: string;
}

const LEVELS = [
  { v: 'INFO', label: 'Informação' },
  { v: 'WARNING', label: 'Atenção' },
  { v: 'MAINTENANCE', label: 'Manutenção/Instabilidade' },
];
const LEVEL_COLOR: Record<string, string> = { INFO: '#0ea5e9', WARNING: '#f59e0b', MAINTENANCE: '#ef4444' };

export default function AdminAnnouncementsPage() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [level, setLevel] = useState('INFO');

  const { data = [], isLoading } = useQuery<Announcement[]>({
    queryKey: ['admin-announcements'],
    queryFn: async () => (await api.get<Announcement[]>('/api/platform-admin/announcements')).data,
  });

  const create = useMutation({
    mutationFn: async () => api.post('/api/platform-admin/announcements', { title: title.trim(), body: body.trim(), level }),
    onSuccess: () => {
      toast.success('Aviso publicado');
      setTitle(''); setBody('');
      qc.invalidateQueries({ queryKey: ['admin-announcements'] });
    },
    onError: () => toast.error('Falha ao publicar'),
  });

  const toggle = useMutation({
    mutationFn: async (a: Announcement) => api.patch(`/api/platform-admin/announcements/${a.id}`, { active: !a.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-announcements'] }),
  });

  const valid = title.trim() && body.trim();

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* Form */}
      <div className="rounded-xl border p-4 space-y-3 h-fit" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Novo aviso</h4>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Aparece como faixa pra TODOS os usuários até ser desativado.</p>
        <div>
          <Label>Título</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Manutenção programada" autoComplete="off" />
        </div>
        <div>
          <Label>Mensagem</Label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Ex: Sistema em manutenção das 22h às 23h."
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]" style={{ borderColor: 'var(--border-default)' }} />
        </div>
        <div>
          <Label>Tipo</Label>
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{LEVELS.map((l) => <SelectItem key={l.v} value={l.v}>{l.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button onClick={() => create.mutate()} disabled={!valid || create.isPending} className="w-full">
          <Send className="mr-1.5 h-4 w-4" /> {create.isPending ? 'Publicando...' : 'Publicar aviso'}
        </Button>
      </div>

      {/* List */}
      <div className="space-y-2">
        {isLoading ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />) : data.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground" style={{ borderColor: 'var(--border-default)' }}>Nenhum aviso criado.</div>
        ) : data.map((a) => (
          <div key={a.id} className="rounded-lg border p-3 flex items-start justify-between gap-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: a.active ? LEVEL_COLOR[a.level] : '#6b7280' }} />
                <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{a.title}</span>
                {!a.active && <span className="text-[10px] rounded px-1.5" style={{ background: 'var(--bg-surface-3)', color: 'var(--text-muted)' }}>inativo</span>}
              </div>
              <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{a.body}</p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{format(new Date(a.created_at), 'dd/MM/yy HH:mm')}</p>
            </div>
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" title={a.active ? 'Desativar' : 'Ativar'} onClick={() => toggle.mutate(a)}>
              <Power className={`h-4 w-4 ${a.active ? 'text-emerald-500' : 'text-muted-foreground'}`} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
