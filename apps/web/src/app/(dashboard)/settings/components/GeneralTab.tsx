'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export function GeneralTab() {
  const tenant = useAuthStore((s) => s.tenant);
  const setTenant = useAuthStore((s) => s.setTenant);
  const [isPending, setIsPending] = useState(false);

  if (!tenant) return null;

  const handlePoolToggle = async (checked: boolean) => {
    setIsPending(true);
    try {
      const { data } = await api.patch<{ id: string; nome: string; pool_enabled: boolean }>(
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
    </div>
  );
}
