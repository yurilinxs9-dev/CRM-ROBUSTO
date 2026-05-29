'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, KeyRound, BookOpen, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ApiKeyFormDialog } from './api-keys/ApiKeyFormDialog';
import { ApiDocs } from './api-keys/ApiDocs';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  active: boolean;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const API = '/api/api-keys';

function fmtDate(v: string | null): string {
  if (!v) return 'nunca';
  return new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function ApiKeysTab() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['api-keys'],
    queryFn: async () => (await api.get<ApiKey[]>(API)).data,
  });

  const revokeMut = useMutation({
    mutationFn: async (id: string) => api.delete(`${API}/${id}`),
    onSuccess: () => {
      toast.success('Chave revogada');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: () => toast.error('Falha ao revogar'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">API Keys</h3>
          <p className="text-sm text-muted-foreground">
            Chaves para integrações externas consumirem a API REST do CRM
            (<code className="text-xs bg-secondary px-1 py-0.5 rounded">/api/v1</code>).
            O token é exibido uma única vez na criação.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> Nova chave
        </Button>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Carregando...</div>}

      {!isLoading && keys.length === 0 && (
        <div className="border border-dashed rounded-lg p-8 text-center text-muted-foreground">
          Nenhuma chave criada. Clique em "Nova chave" para gerar um token de API.
        </div>
      )}

      <div className="space-y-2">
        {keys.map((k) => (
          <div key={k.id} className="border rounded-lg p-4 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${k.active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <span className="font-medium truncate">{k.name}</span>
                {!k.active && (
                  <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">revogada</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                <KeyRound className="w-3 h-3" />
                <code className="font-mono">{k.prefix}••••••••</code>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {k.scopes.map((s) => (
                  <span key={s} className="text-xs bg-secondary px-2 py-0.5 rounded">{s}</span>
                ))}
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                Criada {fmtDate(k.created_at)} · Último uso: {fmtDate(k.last_used_at)}
              </div>
            </div>
            {k.active && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button size="icon" variant="ghost" title="Revogar"
                  onClick={() => {
                    if (confirm(`Revogar a chave "${k.name}"? Integrações que a usam vão parar de funcionar.`)) {
                      revokeMut.mutate(k.id);
                    }
                  }}>
                  <Trash2 className="w-4 h-4 text-red-500" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Documentação da API */}
      <div className="border rounded-lg">
        <button
          type="button"
          onClick={() => setDocsOpen((v) => !v)}
          className="w-full flex items-center gap-2 p-4 text-left hover:bg-accent/50 transition rounded-lg"
        >
          <BookOpen className="w-4 h-4" />
          <span className="font-medium">Documentação da API</span>
          <span className="text-sm text-muted-foreground">— endpoints, autenticação e exemplos</span>
          <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${docsOpen ? 'rotate-180' : ''}`} />
        </button>
        {docsOpen && (
          <div className="border-t p-4">
            <ApiDocs />
          </div>
        )}
      </div>

      <ApiKeyFormDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
