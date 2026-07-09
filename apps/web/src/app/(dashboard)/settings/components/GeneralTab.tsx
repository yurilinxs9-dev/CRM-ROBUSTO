'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type TenantSettings = { id: string; nome: string; pool_enabled: boolean; prefix_enabled: boolean; round_robin_enabled?: boolean; share_history_enabled?: boolean };

interface Instance {
  id: string;
  nome: string;
  status: string;
  owner_user_id: string | null;
}

export function GeneralTab() {
  const tenant = useAuthStore((s) => s.tenant);
  const setTenant = useAuthStore((s) => s.setTenant);
  const [isPending, setIsPending] = useState(false);

  // Conta instâncias open por dono pra detectar config inconsistente:
  // Atendimento Compartilhado (pool_enabled=true) com 2+ números de
  // operadores diferentes não faz sentido — cliente vê números distintos
  // mas o app trata como pool. Mostra alerta.
  const { data: instances = [] } = useQuery<Instance[]>({
    queryKey: ['instances', 'all'],
    queryFn: async () => {
      const res = await api.get<Instance[]>('/api/instances');
      return res.data;
    },
    staleTime: 30_000,
  });

  if (!tenant) return null;

  const openInstances = instances.filter((i) => i.status === 'open');
  const distinctOwners = new Set(
    openInstances.map((i) => i.owner_user_id ?? '_').filter((id) => id !== '_'),
  );
  const inconsistent = tenant.pool_enabled && distinctOwners.size > 1;

  const handlePoolToggle = async (checked: boolean) => {
    setIsPending(true);
    try {
      const { data } = await api.patch<TenantSettings>(
        '/api/tenants/settings',
        { pool_enabled: checked },
      );
      setTenant(data);
      toast.success(
        checked
          ? 'Atendimento Compartilhado ativado.'
          : 'Atendimento Individual ativado.',
      );
    } catch {
      toast.error('Erro ao salvar configuração.');
    } finally {
      setIsPending(false);
    }
  };

  const handleRoundRobinToggle = async (checked: boolean) => {
    setIsPending(true);
    try {
      const { data } = await api.patch<TenantSettings>(
        '/api/tenants/settings',
        { round_robin_enabled: checked },
      );
      setTenant(data);
      toast.success(
        checked
          ? 'Distribuição automática (round-robin) ativada.'
          : 'Distribuição automática desativada.',
      );
    } catch {
      toast.error('Erro ao salvar configuração.');
    } finally {
      setIsPending(false);
    }
  };

  const handleShareHistoryToggle = async (checked: boolean) => {
    setIsPending(true);
    try {
      const { data } = await api.patch<TenantSettings>(
        '/api/tenants/settings',
        { share_history_enabled: checked },
      );
      setTenant(data);
      toast.success(
        checked
          ? 'Histórico compartilhado na transferência ativado.'
          : 'Histórico compartilhado na transferência desativado.',
      );
    } catch {
      toast.error('Erro ao salvar configuração.');
    } finally {
      setIsPending(false);
    }
  };

  const handlePrefixToggle = async (checked: boolean) => {
    setIsPending(true);
    try {
      const { data } = await api.patch<TenantSettings>(
        '/api/tenants/settings',
        { prefix_enabled: checked },
      );
      setTenant(data);
      toast.success(
        checked
          ? 'Assinatura do operador ativada.'
          : 'Assinatura do operador desativada.',
      );
    } catch {
      toast.error('Erro ao salvar configuração.');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="rounded-lg border px-4 py-4 space-y-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Modelo de atendimento</Label>
          <p className="text-xs text-muted-foreground">
            Define como os leads são distribuídos entre os operadores da equipe.
          </p>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">
              {tenant.pool_enabled
                ? 'Atendimento Compartilhado (1 número, vários operadores)'
                : 'Atendimento Individual (1 número por operador)'}
            </Label>
            <p className="text-xs text-muted-foreground">
              {tenant.pool_enabled ? (
                <>
                  Um único número de WhatsApp para toda a equipe. Leads chegam
                  no <strong>pool</strong>; qualquer operador pode assumir
                  pelo botão <em>Assumir</em>. Recomendado quando os clientes
                  veem só uma marca/atendimento, e a equipe se reveza no mesmo
                  número.
                </>
              ) : (
                <>
                  Cada operador conecta seu próprio número de WhatsApp. Leads
                  recebidos em um número viram automaticamente do dono daquele
                  número. Operadores não veem leads dos colegas. Recomendado
                  para equipes pequenas com clientes pessoais (médicos,
                  advogados, consultores).
                </>
              )}
            </p>
          </div>
          <Switch
            checked={tenant.pool_enabled}
            onCheckedChange={handlePoolToggle}
            disabled={isPending}
            aria-label="Modelo de atendimento"
          />
        </div>

        {inconsistent && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <p>
              <strong>Atenção:</strong> Atendimento Compartilhado está ativo,
              mas há {distinctOwners.size} operadores com números próprios
              conectados. No modo compartilhado, normalmente só 1 número fica
              ativo. Considere desconectar instâncias dos operadores ou trocar
              para Atendimento Individual.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">
            Distribuição automática por setor (round-robin)
          </Label>
          <p className="text-xs text-muted-foreground">
            Só no Atendimento Compartilhado. Quando ativo, cada novo lead é
            atribuído automaticamente ao próximo atendente do setor, em rodízio
            (A, B, A, B…), em vez de ficar no pool aguardando alguém assumir. O
            setor de destino vem do número de WhatsApp que recebeu a mensagem.
          </p>
        </div>
        <Switch
          checked={tenant.round_robin_enabled === true}
          onCheckedChange={handleRoundRobinToggle}
          disabled={isPending || !tenant.pool_enabled}
          aria-label="Distribuição round-robin"
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">
            Compartilhar histórico na transferência
          </Label>
          <p className="text-xs text-muted-foreground">
            Quando um lead é transferido (manual ou distribuição automática), o
            novo atendente vê <strong>toda a conversa anterior</strong> para
            ter contexto e dar sequência. Desativado, o histórico anterior à
            transferência fica oculto para o novo atendente (privacidade entre
            operadores). Gerentes sempre veem tudo.
          </p>
        </div>
        <Switch
          checked={tenant.share_history_enabled === true}
          onCheckedChange={handleShareHistoryToggle}
          disabled={isPending}
          aria-label="Compartilhar histórico na transferência"
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">
            Assinar mensagens com nome do operador
          </Label>
          <p className="text-xs text-muted-foreground">
            Só faz sentido em Atendimento Compartilhado: prefixa cada mensagem
            enviada com o nome do operador (ex: <em>*Dr. Yuri*</em>) para o
            cliente saber quem está respondendo. Desative para enviar só o
            texto, sem identificação.
          </p>
        </div>
        <Switch
          checked={tenant.prefix_enabled !== false}
          onCheckedChange={handlePrefixToggle}
          disabled={isPending || !tenant.pool_enabled}
          aria-label="Assinatura do operador"
        />
      </div>
    </div>
  );
}
