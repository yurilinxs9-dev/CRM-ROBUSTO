'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wifi,
  WifiOff,
  Loader2,
  Plus,
  QrCode,
  Power,
  RotateCcw,
  Trash2,
  X,
  Smartphone,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

// --- Types ---

interface Instance {
  id: string;
  nome: string;
  telefone?: string;
  status: string;
  ultimo_check?: string;
}

interface QrResponse {
  qrcode?: { base64?: string };
  base64?: string;
}

type InstanceStatus = 'open' | 'connected' | 'disconnected' | 'close' | 'connecting';

const statusConfig: Record<string, { label: string; color: string; bg: string; type: 'connected' | 'disconnected' | 'connecting' }> = {
  open:         { label: 'Conectado',    color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  type: 'connected' },
  connected:    { label: 'Conectado',    color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  type: 'connected' },
  disconnected: { label: 'Desconectado', color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  type: 'disconnected' },
  close:        { label: 'Desconectado', color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  type: 'disconnected' },
  connecting:   { label: 'Conectando',   color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', type: 'connecting' },
};

function getStatus(status: string) {
  return statusConfig[status] ?? statusConfig.disconnected;
}

function timeAgo(dateStr?: string): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  return `${days}d atrás`;
}

// --- Main Component ---

export default function InstancesPage() {
  const queryClient = useQueryClient();
  const [qrModal, setQrModal] = useState<{ nome: string; qr: string } | null>(null);
  const [createModal, setCreateModal] = useState(false);
  const [createName, setCreateName] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const qrRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Queries ---

  const { data: instances = [], isLoading } = useQuery<Instance[]>({
    queryKey: ['instances'],
    queryFn: async () => {
      const { data } = await api.get('/api/instances');
      return (data as Instance[]) ?? [];
    },
    refetchInterval: 30_000,
  });

  // --- Mutations ---

  const createMutation = useMutation({
    mutationFn: async (nome: string) => {
      const { data } = await api.post('/api/instances', { nome });
      return data as Instance;
    },
    onSuccess: () => {
      toast.success('Instância criada com sucesso');
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setCreateModal(false);
      setCreateName('');
    },
    onError: () => {
      toast.error('Erro ao criar instância');
    },
  });

  const reconnectMutation = useMutation({
    mutationFn: async (nome: string) => {
      await api.post(`/api/instances/${nome}/reconnect`);
    },
    onSuccess: (_data, nome) => {
      toast.success(`Reconectando ${nome}...`);
      queryClient.invalidateQueries({ queryKey: ['instances'] });
    },
    onError: () => {
      toast.error('Erro ao reconectar');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (nome: string) => {
      await api.delete(`/api/instances/${nome}`);
    },
    onSuccess: (_data, nome) => {
      toast.success(`Instância ${nome} removida`);
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setDeleteConfirm(null);
    },
    onError: () => {
      toast.error('Erro ao remover instância');
    },
  });

  // --- QR Code ---

  const fetchQr = useCallback(async (nome: string) => {
    try {
      const { data } = await api.get(`/api/instances/${nome}/qr`);
      const d = data as QrResponse;
      const base64 = d?.qrcode?.base64 ?? d?.base64 ?? '';
      if (base64) {
        setQrModal({ nome, qr: base64 });
      } else {
        setQrModal({ nome, qr: '' });
        toast.error('QR Code não disponível');
      }
    } catch {
      toast.error('Erro ao buscar QR Code');
    }
  }, []);

  const closeQrModal = useCallback(() => {
    setQrModal(null);
    if (qrRefreshRef.current) {
      clearInterval(qrRefreshRef.current);
      qrRefreshRef.current = null;
    }
  }, []);

  // Auto-refresh QR every 20s
  useEffect(() => {
    if (!qrModal) return;

    qrRefreshRef.current = setInterval(() => {
      fetchQr(qrModal.nome);
    }, 20_000);

    return () => {
      if (qrRefreshRef.current) {
        clearInterval(qrRefreshRef.current);
        qrRefreshRef.current = null;
      }
    };
  }, [qrModal?.nome, fetchQr]);

  // --- Socket.IO real-time ---

  useEffect(() => {
    const socket = getSocket();

    const handleStatusChanged = (payload: { instanceName?: string; nome?: string; status?: string }) => {
      const name = payload.instanceName ?? payload.nome;
      const status = payload.status;
      if (!name || !status) return;

      queryClient.setQueryData<Instance[]>(['instances'], (old) => {
        if (!old) return old;
        return old.map((inst) =>
          inst.nome === name ? { ...inst, status, ultimo_check: new Date().toISOString() } : inst,
        );
      });

      // Auto-close QR modal when connected
      if ((status === 'open' || status === 'connected') && qrModal?.nome === name) {
        toast.success(`${name} conectado!`);
        closeQrModal();
      }
    };

    const handleQrCode = (payload: { instanceName?: string; nome?: string; base64?: string; qrcode?: { base64?: string } }) => {
      const name = payload.instanceName ?? payload.nome;
      const base64 = payload.qrcode?.base64 ?? payload.base64 ?? '';
      if (name && qrModal?.nome === name && base64) {
        setQrModal({ nome: name, qr: base64 });
      }
    };

    socket.on('instance:status-changed', handleStatusChanged);
    socket.on('instance:qr-code', handleQrCode);

    return () => {
      socket.off('instance:status-changed', handleStatusChanged);
      socket.off('instance:qr-code', handleQrCode);
    };
  }, [queryClient, qrModal?.nome, closeQrModal]);

  // --- Render ---

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            Instâncias WhatsApp
          </h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {instances.length} instância(s) configurada(s)
          </p>
        </div>
        <button
          onClick={() => setCreateModal(true)}
          className="flex items-center gap-2 h-9 px-4 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
          style={{ background: 'var(--primary)', color: 'white' }}
        >
          <Plus size={16} />
          Nova Instância
        </button>
      </div>

      {/* Loading */}
      {isLoading ? (
        <div className="flex items-center gap-2 py-12 justify-center" style={{ color: 'var(--text-muted)' }}>
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Carregando instâncias...</span>
        </div>
      ) : (
        /* Grid */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {instances.map((inst) => {
            const s = getStatus(inst.status);
            return (
              <div
                key={inst.id}
                className="rounded-xl p-5 border transition-all hover:border-[var(--border-strong)]"
                style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
              >
                {/* Top: name + status */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ background: s.bg }}
                    >
                      <Smartphone size={16} style={{ color: s.color }} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                        {inst.nome}
                      </p>
                      {inst.telefone && (
                        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                          {inst.telefone}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setDeleteConfirm(inst.nome)}
                    className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-surface-3)]"
                    style={{ color: 'var(--text-muted)' }}
                    title="Excluir instância"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Status badge */}
                <div className="flex items-center justify-between mb-4">
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                    style={{ background: s.bg, color: s.color }}
                  >
                    <span className="relative flex h-2 w-2">
                      {s.type === 'connected' && (
                        <span
                          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                          style={{ background: s.color }}
                        />
                      )}
                      {s.type === 'connecting' && (
                        <span
                          className="animate-spin absolute inline-flex h-full w-full rounded-full border border-transparent"
                          style={{ borderTopColor: s.color }}
                        />
                      )}
                      <span
                        className="relative inline-flex rounded-full h-2 w-2"
                        style={{ background: s.color }}
                      />
                    </span>
                    {s.label}
                  </span>
                  {inst.ultimo_check && (
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {timeAgo(inst.ultimo_check)}
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {s.type === 'connected' ? (
                    <>
                      <button
                        onClick={() => reconnectMutation.mutate(inst.nome)}
                        disabled={reconnectMutation.isPending}
                        className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
                        style={{ background: 'var(--bg-surface-3)', color: 'var(--text-secondary)' }}
                      >
                        <RotateCcw size={13} />
                        Reiniciar
                      </button>
                      <button
                        onClick={() => reconnectMutation.mutate(inst.nome)}
                        disabled={reconnectMutation.isPending}
                        className="flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
                        style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}
                      >
                        <Power size={13} />
                        Desconectar
                      </button>
                    </>
                  ) : s.type === 'connecting' ? (
                    <button
                      onClick={() => fetchQr(inst.nome)}
                      className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium transition-opacity hover:opacity-80"
                      style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}
                    >
                      <QrCode size={13} />
                      Ver QR Code
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => fetchQr(inst.nome)}
                        className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium transition-opacity hover:opacity-80"
                        style={{ background: 'var(--primary)', color: 'white' }}
                      >
                        <QrCode size={13} />
                        Conectar QR
                      </button>
                      <button
                        onClick={() => reconnectMutation.mutate(inst.nome)}
                        disabled={reconnectMutation.isPending}
                        className="flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
                        style={{ background: 'var(--bg-surface-3)', color: 'var(--text-secondary)' }}
                      >
                        <RotateCcw size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {instances.length === 0 && (
            <div
              className="col-span-full flex flex-col items-center justify-center py-16 rounded-xl border border-dashed"
              style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
            >
              <WifiOff size={32} className="mb-3 opacity-50" />
              <p className="text-sm font-medium mb-1">Nenhuma instância criada</p>
              <p className="text-xs">Clique em &quot;Nova Instância&quot; para começar</p>
            </div>
          )}
        </div>
      )}

      {/* QR Code Modal */}
      {qrModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={closeQrModal}
        >
          <div
            className="rounded-2xl p-6 text-center w-full max-w-sm mx-4"
            style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                Escanear QR Code
              </h3>
              <button
                onClick={closeQrModal}
                className="p-1 rounded-md transition-colors hover:bg-[var(--bg-surface-3)]"
                style={{ color: 'var(--text-muted)' }}
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              {qrModal.nome}
            </p>

            {qrModal.qr ? (
              <div className="flex flex-col items-center gap-3">
                <img
                  src={qrModal.qr}
                  alt="QR Code"
                  className="w-64 h-64 rounded-lg"
                  style={{ background: 'white' }}
                />
                <div className="flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 size={14} className="animate-spin" />
                  <span className="text-xs">Aguardando scan... (atualiza a cada 20s)</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-8" style={{ color: 'var(--text-muted)' }}>
                <QrCode size={32} className="opacity-40" />
                <p className="text-sm">QR Code não disponível</p>
                <button
                  onClick={() => fetchQr(qrModal.nome)}
                  className="mt-2 px-4 h-8 rounded-lg text-xs font-medium transition-opacity hover:opacity-80"
                  style={{ background: 'var(--primary)', color: 'white' }}
                >
                  Tentar novamente
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Instance Modal */}
      {createModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setCreateModal(false)}
        >
          <div
            className="rounded-2xl p-6 w-full max-w-sm mx-4"
            style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                Nova Instância
              </h3>
              <button
                onClick={() => setCreateModal(false)}
                className="p-1 rounded-md transition-colors hover:bg-[var(--bg-surface-3)]"
                style={{ color: 'var(--text-muted)' }}
              >
                <X size={16} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = createName.trim();
                if (!trimmed) return;
                createMutation.mutate(trimmed);
              }}
            >
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Nome da instância
              </label>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Ex: atendimento-01"
                autoFocus
                className="w-full h-9 px-3 rounded-lg text-sm outline-none transition-colors"
                style={{
                  background: 'var(--bg-surface-3)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-default)',
                }}
              />
              <button
                type="submit"
                disabled={!createName.trim() || createMutation.isPending}
                className="w-full mt-4 h-9 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ background: 'var(--primary)', color: 'white' }}
              >
                {createMutation.isPending ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Criando...
                  </>
                ) : (
                  <>
                    <Plus size={14} />
                    Criar Instância
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="rounded-2xl p-6 w-full max-w-sm mx-4"
            style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-default)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(239,68,68,0.12)' }}
              >
                <AlertTriangle size={18} style={{ color: '#ef4444' }} />
              </div>
              <div>
                <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                  Excluir instância
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Esta ação não pode ser desfeita.
                </p>
              </div>
            </div>

            <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
              Tem certeza que deseja excluir <strong style={{ color: 'var(--text-primary)' }}>{deleteConfirm}</strong>?
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 h-9 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
                style={{ background: 'var(--bg-surface-3)', color: 'var(--text-secondary)' }}
              >
                Cancelar
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirm)}
                disabled={deleteMutation.isPending}
                className="flex-1 h-9 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-50 flex items-center justify-center gap-1.5"
                style={{ background: '#ef4444', color: 'white' }}
              >
                {deleteMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
