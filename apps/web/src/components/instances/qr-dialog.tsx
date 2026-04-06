'use client';

import { useEffect } from 'react';
import { Loader2, RefreshCw, QrCode as QrIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Props {
  open: boolean;
  instanceName: string | null;
  qrBase64: string | null;
  status: string;
  onClose: () => void;
  onRefresh: () => void;
}

function normalizeQr(qr: string | null): string | null {
  if (!qr) return null;
  if (qr.startsWith('data:image')) return qr;
  return `data:image/png;base64,${qr}`;
}

export function QrDialog({ open, instanceName, qrBase64, status, onClose, onRefresh }: Props) {
  // Auto-refresh polling every 20s while open and not connected
  useEffect(() => {
    if (!open || !instanceName) return;
    if (status === 'open' || status === 'connected') return;
    const id = setInterval(onRefresh, 20_000);
    return () => clearInterval(id);
  }, [open, instanceName, status, onRefresh]);

  const qrSrc = normalizeQr(qrBase64);
  const isConnected = status === 'open' || status === 'connected';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Escaneie o QR Code</DialogTitle>
          <DialogDescription>
            Abra o WhatsApp &gt; Configurações &gt; Aparelhos conectados e escaneie o código abaixo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          <div className="flex h-[320px] w-[320px] items-center justify-center rounded-xl bg-white p-4">
            {qrSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrSrc} alt="QR Code" className="h-full w-full object-contain" />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <QrIcon className="h-10 w-10 opacity-40" />
                <span className="text-xs">Aguardando QR...</span>
              </div>
            )}
          </div>

          {isConnected ? (
            <Badge variant="success">Conectado</Badge>
          ) : status === 'connecting' ? (
            <Badge variant="warning" className="gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              Conectando
            </Badge>
          ) : (
            <Badge variant="destructive">Aguardando scan</Badge>
          )}

          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Atualizar QR
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
