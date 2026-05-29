'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { OutboundWebhook } from '../WebhooksTab';

const ALL_EVENTS = [
  { value: 'message.created', label: 'Mensagem criada (enviada/recebida)' },
  { value: 'lead.created',    label: 'Lead criado' },
  { value: 'lead.updated',    label: 'Lead atualizado' },
  { value: 'deal.won',        label: 'Negócio ganho' },
  { value: 'deal.lost',       label: 'Negócio perdido' },
];

interface Props {
  open: boolean;
  webhook: OutboundWebhook | null;
  onClose: () => void;
}

interface FormState {
  name: string;
  url: string;
  events: string[];
  active: boolean;
  secret: string;
  custom_headers: string;
}

const empty: FormState = {
  name: '', url: '', events: [], active: true, secret: '', custom_headers: '',
};

export function WebhookFormDialog({ open, webhook, onClose }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(empty);
  const [headersError, setHeadersError] = useState<string | null>(null);

  useEffect(() => {
    if (webhook) {
      setForm({
        name: webhook.name,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        secret: webhook.secret ?? '',
        custom_headers: webhook.custom_headers
          ? JSON.stringify(webhook.custom_headers, null, 2)
          : '',
      });
    } else {
      setForm(empty);
    }
    setHeadersError(null);
  }, [webhook, open]);

  const mut = useMutation({
    mutationFn: async () => {
      let custom_headers: Record<string, string> | null = null;
      if (form.custom_headers.trim()) {
        try {
          custom_headers = JSON.parse(form.custom_headers);
          if (typeof custom_headers !== 'object' || Array.isArray(custom_headers)) {
            throw new Error('Não é objeto');
          }
        } catch {
          setHeadersError('JSON inválido. Use: {"Header":"valor"}');
          throw new Error('headers');
        }
      }
      const body = {
        name: form.name.trim(),
        url: form.url.trim(),
        events: form.events,
        active: form.active,
        secret: form.secret.trim() || null,
        custom_headers,
      };
      if (webhook) return api.patch(`/api/outbound-webhooks/${webhook.id}`, body);
      return api.post('/api/outbound-webhooks', body);
    },
    onSuccess: () => {
      toast.success(webhook ? 'Webhook atualizado' : 'Webhook criado');
      qc.invalidateQueries({ queryKey: ['outbound-webhooks'] });
      onClose();
    },
    onError: (err: unknown) => {
      if ((err as Error).message === 'headers') return;
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(typeof msg === 'string' ? msg : 'Erro ao salvar');
    },
  });

  const valid = form.name.trim() && form.url.trim() && form.events.length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{webhook ? 'Editar webhook' : 'Novo webhook'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label>Nome da integração</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Ex: Integração IA - Resposta Rápida"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
          </div>

          <div>
            <Label>URL do webhook</Label>
            <Input
              type="url"
              name="webhook_target_url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://n8n.seudominio.com/webhook/abc123"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
          </div>

          <div>
            <Label>Eventos</Label>
            <div className="space-y-2 mt-2">
              {ALL_EVENTS.map((ev) => {
                const checked = form.events.includes(ev.value);
                return (
                  <label key={ev.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      checked={checked}
                      onChange={(e) => {
                        setForm({
                          ...form,
                          events: e.target.checked
                            ? [...form.events, ev.value]
                            : form.events.filter((x) => x !== ev.value),
                        });
                      }}
                    />
                    <span className="text-sm">{ev.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <Label>Secret (HMAC SHA256) — opcional</Label>
            <Input
              type="password"
              value={form.secret}
              onChange={(e) => setForm({ ...form, secret: e.target.value })}
              placeholder="Assinatura em header X-CRM-Signature"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
            />
          </div>

          <div>
            <Label>Headers customizados (JSON) — opcional</Label>
            <textarea
              className="w-full mt-1 border rounded p-2 text-sm font-mono"
              rows={3}
              value={form.custom_headers}
              onChange={(e) => { setForm({ ...form, custom_headers: e.target.value }); setHeadersError(null); }}
              placeholder='{"Authorization":"Bearer xxx"}'
            />
            {headersError && <p className="text-xs text-red-500 mt-1">{headersError}</p>}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={form.active}
              onCheckedChange={(v) => setForm({ ...form, active: v })}
            />
            <Label>Ativo</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={!valid || mut.isPending}
          >
            {mut.isPending ? 'Salvando...' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
