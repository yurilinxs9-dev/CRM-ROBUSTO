'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, MessageCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import axios from 'axios';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InstanceCard, type InstanceCardData } from '@/components/instances/instance-card';
import { QrDialog } from '@/components/instances/qr-dialog';
import { NewInstanceDialog } from '@/components/instances/new-instance-dialog';

interface QrResponse {
  qrcode?: { base64?: string };
  base64?: string;
  alreadyConnected?: boolean;
}

export default function InstancesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [qrTarget, setQrTarget] = useState<string | null>(null);
  const [qrBase64, setQrBase64] = useState<string | null>(null);

  const { data: instances = [], isLoading } = useQuery<InstanceCardData[]>({
    queryKey: ['instances'],
    queryFn: async () => {
      const { data } = await api.get('/api/instances');
      return (data as InstanceCardData[]) ?? [];
    },
    refetchInterval: 5_000,
  });

  const createMutation = useMutation({
    mutationFn: async (nome: string) => {
      const { data } = await api.post('/api/instances', { nome });
      return data as InstanceCardData;
    },
    onSuccess: (created, nome) => {
      toast.success('Instância criada');
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setCreateOpen(false);
      // Auto-open QR for the new instance
      const target = created?.nome ?? nome;
      setQrTarget(target);
      void fetchQr(target);
    },
    onError: () => toast.error('Erro ao criar instância'),
  });

  const reconnectMutation = useMutation({
    mutationFn: async (nome: string) => {
      await api.post(`/api/instances/${nome}/reconnect`);
    },
    onSuccess: (_d, nome) => {
      toast.success(`Reconectando ${nome}...`);
      queryClient.invalidateQueries({ queryKey: ['instances'] });
    },
    onError: () => toast.error('Erro ao reconectar'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (nome: string) => {
      await api.delete(`/api/instances/${nome}`);
    },
    onSuccess: (_d, nome) => {
      toast.success(`Instância ${nome} removida`);
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setDeleteTarget(null);
    },
    onError: () => toast.error('Erro ao remover instância'),
  });

  const fetchQr = useCallback(async (nome: string) => {
    try {
      const { data } = await api.get(`/api/instances/${nome}/qr`);
      const d = data as QrResponse;
      if (d?.alreadyConnected) {
        toast.success(`${nome} já está conectado`);
        setQrBase64(null);
        setQrTarget(null);
        queryClient.invalidateQueries({ queryKey: ['instances'] });
        return;
      }
      const base64 = d?.qrcode?.base64 ?? d?.base64 ?? '';
      setQrBase64(base64 || null);
      if (!base64) toast.error('QR Code não disponível');
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        toast.error('Instância não encontrada');
        setQrBase64(null);
        setQrTarget(null);
        queryClient.invalidateQueries({ queryKey: ['instances'] });
        return;
      }
      toast.error('Erro ao buscar QR Code');
      setQrBase64(null);
    }
  }, [queryClient]);

  const handleConnect = useCallback(
    (nome: string) => {
      setQrTarget(nome);
      setQrBase64(null);
      void fetchQr(nome);
    },
    [fetchQr],
  );

  const closeQr = useCallback(() => {
    setQrTarget(null);
    setQrBase64(null);
  }, []);

  // Poll UazAPI status while QR modal is open (works without webhook tunnel)
  useEffect(() => {
    if (!qrTarget) return;
    let cancelled = false;
    const tick = async () => {
      try {
        await api.get(`/api/instances/${qrTarget}/status`);
        if (!cancelled) queryClient.invalidateQueries({ queryKey: ['instances'] });
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          if (cancelled) return;
          toast.error('Instância não encontrada');
          cancelled = true;
          setQrTarget(null);
          setQrBase64(null);
          queryClient.invalidateQueries({ queryKey: ['instances'] });
        }
      }
    };
    const id = setInterval(tick, 3_000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [qrTarget, queryClient]);

  // Socket: real-time status + QR
  useEffect(() => {
    const socket = getSocket();

    const handleStatusChanged = (payload: { instanceName?: string; nome?: string; status?: string }) => {
      const name = payload.instanceName ?? payload.nome;
      const status = payload.status;
      if (!name || !status) return;

      queryClient.setQueryData<InstanceCardData[]>(['instances'], (old) =>
        old?.map((i) => (i.nome === name ? { ...i, status, ultimo_check: new Date().toISOString() } : i)),
      );

      if ((status === 'open' || status === 'connected') && qrTarget === name) {
        toast.success(`${name} conectado!`);
        closeQr();
      }
    };

    const handleQrCode = (payload: { instanceName?: string; nome?: string; base64?: string; qrCode?: string; qrcode?: { base64?: string } }) => {
      const name = payload.instanceName ?? payload.nome;
      const base64 = payload.qrcode?.base64 ?? payload.base64 ?? payload.qrCode ?? '';
      if (name && qrTarget === name && base64) setQrBase64(base64);
    };

    socket.on('instance:status-changed', handleStatusChanged);
    socket.on('instance:qr-code', handleQrCode);
    return () => {
      socket.off('instance:status-changed', handleStatusChanged);
      socket.off('instance:qr-code', handleQrCode);
    };
  }, [queryClient, qrTarget, closeQr]);

  const qrInstance = qrTarget ? instances.find((i) => i.nome === qrTarget) : null;
  const qrStatus = qrInstance?.status ?? 'disconnected';

  // Auto-close QR modal once polled status reports connected
  useEffect(() => {
    if (qrTarget && (qrStatus === 'open' || qrStatus === 'connected')) {
      toast.success(`${qrTarget} conectado!`);
      closeQr();
    }
  }, [qrTarget, qrStatus, closeQr]);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Instâncias WhatsApp</h1>
          <p className="text-sm text-muted-foreground mt-1">Gerencie as conexões do WhatsApp</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Nova Instância
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : instances.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
              <MessageCircle className="h-7 w-7" />
            </div>
            <div>
              <p className="font-semibold">Nenhuma instância criada</p>
              <p className="text-sm text-muted-foreground">
                Crie sua primeira conexão WhatsApp para começar a receber mensagens.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)} className="mt-2">
              <Plus className="mr-1.5 h-4 w-4" />
              Criar primeira instância
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {instances.map((inst) => (
            <InstanceCard
              key={inst.id}
              instance={inst}
              onConnect={handleConnect}
              onReconnect={(nome) => reconnectMutation.mutate(nome)}
              onDelete={(nome) => setDeleteTarget(nome)}
              reconnecting={reconnectMutation.isPending && reconnectMutation.variables === inst.nome}
            />
          ))}
        </div>
      )}

      <NewInstanceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(nome) => createMutation.mutate(nome)}
        isPending={createMutation.isPending}
      />

      <QrDialog
        open={qrTarget !== null}
        instanceName={qrTarget}
        qrBase64={qrBase64}
        status={qrStatus}
        onClose={closeQr}
        onRefresh={() => qrTarget && fetchQr(qrTarget)}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle>Excluir instância</DialogTitle>
                <DialogDescription>Esta ação remove a sessão WhatsApp.</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tem certeza que deseja excluir <span className="font-semibold text-foreground">{deleteTarget}</span>?
            Será necessário escanear o QR Code novamente caso queira reconectar.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
