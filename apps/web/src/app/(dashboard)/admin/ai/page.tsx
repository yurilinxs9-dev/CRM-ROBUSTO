'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Zap, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ModelSelect, useAiModels, type AiModel } from '@/components/ai/model-select';

const PROVIDERS = [
  { v: 'anthropic', label: 'Anthropic (Claude)' },
  { v: 'openai_compatible', label: 'OpenAI-compatible (OpenAI / OpenRouter / local)' },
];

interface AgentConfig {
  id: string;
  system_prompt: string;
  persona: string | null;
  copilot_enabled: boolean;
  suggest_enabled: boolean;
  autoreply_enabled: boolean;
  followup_enabled: boolean;
  default_model_id: string | null;
}

interface ModelForm {
  label: string;
  provider: string;
  base_url: string;
  model_id: string;
  api_key: string;
  temperature: string;
  max_tokens: string;
  is_default: boolean;
}

const EMPTY_FORM: ModelForm = {
  label: '', provider: 'anthropic', base_url: '', model_id: '', api_key: '',
  temperature: '0.7', max_tokens: '1024', is_default: false,
};

export default function AdminAiPage() {
  const qc = useQueryClient();
  const { data: models = [], isLoading } = useAiModels();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AiModel | null>(null);
  const [form, setForm] = useState<ModelForm>(EMPTY_FORM);

  const { data: agent } = useQuery<AgentConfig>({
    queryKey: ['ai-agent'],
    queryFn: async () => (await api.get<AgentConfig>('/api/ai/agent')).data,
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(m: AiModel) {
    setEditing(m);
    setForm({
      label: m.label, provider: m.provider, base_url: m.base_url ?? '', model_id: m.model_id,
      api_key: '', temperature: String(m.temperature), max_tokens: String(m.max_tokens), is_default: m.is_default,
    });
    setDialogOpen(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        label: form.label.trim(),
        provider: form.provider,
        base_url: form.base_url.trim() || null,
        model_id: form.model_id.trim(),
        temperature: Number(form.temperature),
        max_tokens: Number(form.max_tokens),
        is_default: form.is_default,
      };
      if (form.api_key.trim()) payload.api_key = form.api_key.trim();
      if (editing) return api.put(`/api/ai/models/${editing.id}`, payload);
      return api.post('/api/ai/models', payload);
    },
    onSuccess: () => {
      toast.success(editing ? 'Modelo atualizado' : 'Modelo criado');
      setDialogOpen(false);
      qc.invalidateQueries({ queryKey: ['ai-models'] });
    },
    onError: () => toast.error('Falha ao salvar modelo'),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/ai/models/${id}`),
    onSuccess: () => { toast.success('Modelo removido'); qc.invalidateQueries({ queryKey: ['ai-models'] }); },
    onError: () => toast.error('Falha ao remover'),
  });

  const test = useMutation({
    mutationFn: async (id: string) => (await api.post<{ sample: string }>(`/api/ai/models/${id}/test`)).data,
    onSuccess: (d) => toast.success(`Modelo OK: "${d.sample}"`),
    onError: () => toast.error('Teste falhou — verifique chave/modelo'),
  });

  const saveAgent = useMutation({
    mutationFn: async (patch: Partial<AgentConfig>) => api.patch('/api/ai/agent', patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai-agent'] }); toast.success('Config do agente salva'); },
    onError: () => toast.error('Falha ao salvar config'),
  });

  const valid = form.label.trim() && form.model_id.trim() && (editing || form.api_key.trim());

  return (
    <div className="space-y-6">
      {/* Modelos */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Modelos de IA</h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Cadastre qualquer modelo. Anthropic usa o SDK; OpenAI-compatible aceita base_url + model_id livre.</p>
          </div>
          <Button onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" /> Novo modelo</Button>
        </div>

        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
        ) : models.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>Nenhum modelo cadastrado.</div>
        ) : (
          <div className="space-y-2">
            {models.map((m) => (
              <div key={m.id} className="rounded-lg border p-3 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{m.label}</span>
                    {m.is_default && <span className="inline-flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5" style={{ background: 'var(--bg-surface-3)', color: 'var(--primary)' }}><Star className="h-3 w-3" /> padrão</span>}
                    {!m.active && <span className="text-[10px] rounded px-1.5" style={{ background: 'var(--bg-surface-3)', color: 'var(--text-muted)' }}>inativo</span>}
                  </div>
                  <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>{m.provider} · {m.model_id} · chave {m.key_mask}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" className="h-8 w-8" title="Testar" disabled={test.isPending} onClick={() => test.mutate(m.id)}><Zap className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" title="Editar" onClick={() => openEdit(m)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" title="Remover" onClick={() => { if (confirm(`Remover modelo "${m.label}"?`)) remove.mutate(m.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Config do agente */}
      {agent && (
        <section className="rounded-xl border p-4 space-y-4" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Agente de IA</h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Comportamento global + quais recursos estão ligados.</p>
          </div>

          <div>
            <Label>Modelo padrão</Label>
            <ModelSelect value={agent.default_model_id} onChange={(id) => saveAgent.mutate({ default_model_id: id })} />
          </div>

          <div>
            <Label>System prompt</Label>
            <textarea
              defaultValue={agent.system_prompt}
              rows={4}
              onBlur={(e) => { if (e.target.value !== agent.system_prompt) saveAgent.mutate({ system_prompt: e.target.value }); }}
              placeholder="Ex: Você é um assistente de vendas educado e objetivo do CRM..."
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]"
              style={{ borderColor: 'var(--border-default)' }}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ['copilot_enabled', 'Copilot do atendente'],
              ['suggest_enabled', 'Sugerir resposta'],
              ['autoreply_enabled', 'Auto-resposta ao cliente'],
              ['followup_enabled', 'Follow-up por IA'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
                <Switch checked={agent[key]} onCheckedChange={(v) => saveAgent.mutate({ [key]: v })} />
              </label>
            ))}
          </div>
        </section>
      )}

      {/* Dialog criar/editar modelo */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Editar modelo' : 'Novo modelo'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome (exibição)</Label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Ex: Claude Opus (produção)" autoComplete="off" />
            </div>
            <div>
              <Label>Provedor</Label>
              <Select value={form.provider} onValueChange={(v) => setForm({ ...form, provider: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p.v} value={p.v}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Model ID</Label>
              <Input value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })} placeholder={form.provider === 'anthropic' ? 'claude-haiku-4-5 (mais barato)' : 'gpt-4o ou meta-llama/...'} autoComplete="off" />
            </div>
            <div>
              <Label>Base URL <span style={{ color: 'var(--text-muted)' }}>(opcional)</span></Label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder={form.provider === 'anthropic' ? 'vazio = api.anthropic.com' : 'https://openrouter.ai/api/v1'} autoComplete="off" />
            </div>
            <div>
              <Label>API key {editing && <span style={{ color: 'var(--text-muted)' }}>(deixe vazio p/ manter)</span>}</Label>
              <Input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={editing ? '••••••••' : 'sk-...'} autoComplete="off" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Temperature</Label>
                <Input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} />
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>Ignorado p/ Claude Opus 4.7+/Fable.</p>
              </div>
              <div>
                <Label>Max tokens</Label>
                <Input type="number" min="1" value={form.max_tokens} onChange={(e) => setForm({ ...form, max_tokens: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Modelo padrão da plataforma</span>
              <Switch checked={form.is_default} onCheckedChange={(v) => setForm({ ...form, is_default: v })} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>{save.isPending ? 'Salvando...' : 'Salvar'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
