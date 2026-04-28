'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type TenantSettings = { id: string; nome: string; pool_enabled: boolean; prefix_enabled: boolean };

export function GeneralTab() {
  const tenant = useAuthStore((s) => s.tenant);
  const setTenant = useAuthStore((s) => s.setTenant);
  const [isPending, setIsPending] = useState(false);

  if (!tenant) return null;

  const handlePoolToggle = async (checked: boolean) => {
    setIsPending(true);
    try {
      const { data } = await api.patch<TenantSettings>(
        '/api/tenants/settings',
        { pool_enabled: checked },
      );
      setTenant(data);
      toast.success(checked ? 'Modo Escritório ativado.' : 'Modo Escritório desativado.');
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
      toast.success(checked ? 'Prefixo profissional ativado.' : 'Prefixo profissional desativado.');
    } catch {
      toast.error('Erro ao salvar configuração.');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Modo Escritório (Multi-advogado)</Label>
          <p className="text-xs text-muted-foreground">
            Ativa pool de leads, tabs Escritório/Meus Leads, prefixo profissional nas mensagens e botão Assumir.
          </p>
        </div>
        <Switch
          checked={tenant.pool_enabled}
          onCheckedChange={handlePoolToggle}
          disabled={isPending}
          aria-label="Modo Escritório"
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Prefixo profissional nas mensagens</Label>
          <p className="text-xs text-muted-foreground">
            Quando ativado (e Modo Escritório também ON), cada mensagem enviada
            inclui o nome do operador no início (ex: *Dr. Yuri*). Desative para
            mandar apenas o conteúdo da mensagem, sem identificação.
          </p>
        </div>
        <Switch
          checked={tenant.prefix_enabled !== false}
          onCheckedChange={handlePrefixToggle}
          disabled={isPending}
          aria-label="Prefixo profissional"
        />
      </div>
    </div>
  );
}
