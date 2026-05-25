'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, PlayCircle, History, Power } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { WebhookFormDialog } from './webhooks/WebhookFormDialog';
import { DeliveryLogDialog } from './webhooks/DeliveryLogDialog';

export interface OutboundWebhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  secret: string | null;
  custom_headers: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

const API = '/api/outbound-webhooks';

export function WebhooksTab() {
  const qc = useQueryClient();
  const [editTarget, setEditTarget] = useState<OutboundWebhook | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [logTarget, setLogTarget] = useState<OutboundWebhook | null>(null);

  const { data: hooks = [], isLoading } = useQuery<OutboundWebhook[]>({
    queryKey: ['outbound-webhooks'],
    queryFn: async () => (await api.get<OutboundWebhook[]>(API)).data,
  });

  const toggleMut = useMutation({
    mutationFn: async (w: OutboundWebhook) =>
      api.patch(`${API}/${w.id}`, { active: !w.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outbound-webhooks'] }),
  });

  const delMut = useMutation({
    mutationFn: async (id: string) => api.delete(`${API}/${id}`),
    onSuccess: () => {
      toast.success('Webhook removido');
      qc.invalidateQueries({ queryKey: ['outbound-webhooks'] });
    },
  });

  const testMut = useMutation({
    mutationFn: async (id: string) => api.post(`${API}/${id}/test`),
    onSuccess: () => toast.success('Payload de teste enviado'),
    onError: () => toast.error('Falha ao disparar teste'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Webhooks</h3>
          <p className="text-sm text-muted-foreground">
            Exporte eventos do CRM em tempo real para n8n, Make, Zapier ou seu backend.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> Novo webhook
        </Button>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Carregando...</div>}

      {!isLoading && hooks.length === 0 && (
        <div className="border border-dashed rounded-lg p-8 text-center text-muted-foreground">
          Nenhum webhook configurado. Clique em "Novo webhook" para começar.
        </div>
      )}

      <div className="space-y-2">
        {hooks.map((w) => (
          <div key={w.id} className="border rounded-lg p-4 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${w.active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <span className="font-medium truncate">{w.name}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate mt-1">{w.url}</div>
              <div className="flex flex-wrap gap-1 mt-2">
                {w.events.map((e) => (
                  <span key={e} className="text-xs bg-secondary px-2 py-0.5 rounded">{e}</span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button size="icon" variant="ghost" title={w.active ? 'Desativar' : 'Ativar'}
                onClick={() => toggleMut.mutate(w)}>
                <Power className={`w-4 h-4 ${w.active ? 'text-green-600' : 'text-gray-400'}`} />
              </Button>
              <Button size="icon" variant="ghost" title="Testar"
                onClick={() => testMut.mutate(w.id)} disabled={testMut.isPending}>
                <PlayCircle className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" title="Logs"
                onClick={() => setLogTarget(w)}>
                <History className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" title="Editar"
                onClick={() => setEditTarget(w)}>
                <Pencil className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" title="Excluir"
                onClick={() => {
                  if (confirm(`Remover webhook "${w.name}"?`)) delMut.mutate(w.id);
                }}>
                <Trash2 className="w-4 h-4 text-red-500" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <WebhookFormDialog
        open={createOpen || editTarget !== null}
        webhook={editTarget}
        onClose={() => { setCreateOpen(false); setEditTarget(null); }}
      />
      {logTarget && (
        <DeliveryLogDialog webhook={logTarget} onClose={() => setLogTarget(null)} />
      )}
    </div>
  );
}
