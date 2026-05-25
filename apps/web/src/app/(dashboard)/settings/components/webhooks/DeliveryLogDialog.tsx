'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { OutboundWebhook } from '../WebhooksTab';

interface Delivery {
  id: string;
  event_type: string;
  status_code: number | null;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  attempt: number;
  created_at: string;
}

interface Props {
  webhook: OutboundWebhook;
  onClose: () => void;
}

export function DeliveryLogDialog({ webhook, onClose }: Props) {
  const { data: deliveries = [], isLoading } = useQuery<Delivery[]>({
    queryKey: ['webhook-deliveries', webhook.id],
    queryFn: async () =>
      (await api.get<Delivery[]>(`/api/outbound-webhooks/${webhook.id}/deliveries?limit=100`)).data,
    refetchInterval: 5000,
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log de disparos — {webhook.name}</DialogTitle>
        </DialogHeader>

        {isLoading && <div className="text-sm text-muted-foreground p-4">Carregando...</div>}

        {!isLoading && deliveries.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-8">
            Nenhum disparo nos últimos 7 dias.
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs uppercase">
              <tr>
                <th className="px-2 py-1 text-left">Quando</th>
                <th className="px-2 py-1 text-left">Evento</th>
                <th className="px-2 py-1 text-right">Status</th>
                <th className="px-2 py-1 text-right">ms</th>
                <th className="px-2 py-1 text-right">Try</th>
                <th className="px-2 py-1 text-left">Erro</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} className="border-b hover:bg-muted/30">
                  <td className="px-2 py-1 font-mono text-xs">
                    {new Date(d.created_at).toLocaleString('pt-BR')}
                  </td>
                  <td className="px-2 py-1 text-xs">{d.event_type}</td>
                  <td className="px-2 py-1 text-right">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      d.success ? 'bg-green-100 text-green-700'
                                : 'bg-red-100 text-red-700'
                    }`}>
                      {d.status_code ?? 'ERR'}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right text-xs">{d.duration_ms ?? '-'}</td>
                  <td className="px-2 py-1 text-right text-xs">{d.attempt}</td>
                  <td className="px-2 py-1 text-xs text-red-600 truncate max-w-[200px]">
                    {d.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
