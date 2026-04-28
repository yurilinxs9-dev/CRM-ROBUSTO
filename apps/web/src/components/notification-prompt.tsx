'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ensurePushSubscription, pushSupported, requestNotificationPermission } from '@/lib/push';

const STORAGE_KEY = 'push:prompt-dismissed';

const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true);

const isIOS = () =>
  typeof window !== 'undefined' &&
  /iPad|iPhone|iPod/.test(window.navigator.userAgent);

export function NotificationPrompt() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!pushSupported()) return;
    if (Notification.permission !== 'default') {
      if (Notification.permission === 'granted') {
        void ensurePushSubscription().catch(() => undefined);
      }
      return;
    }
    if (localStorage.getItem(STORAGE_KEY) === '1') return;
    const t = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(t);
  }, []);

  const onEnable = async () => {
    setOpen(false);
    const perm = await requestNotificationPermission();
    if (perm !== 'granted') {
      toast.error('Permissao negada');
      return;
    }
    try {
      await ensurePushSubscription();
      toast.success('Notificacoes ativadas');
    } catch {
      toast.error('Falha ao ativar notificacoes');
    }
  };

  const onDismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onDismiss()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>Receber notificacoes</DialogTitle>
              <DialogDescription>Avisos de mensagens, leads e SLA.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Ative as notificacoes do navegador para receber alertas em tempo real, mesmo com o CRM fechado.
        </p>
        {isIOS() && !isStandalone() && (
          <p className="text-xs text-amber-600">
            iPhone: instale o app na Tela de Inicio (botao Compartilhar &gt; Adicionar) antes de ativar.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            <BellOff className="mr-1.5 h-4 w-4" />
            Agora nao
          </Button>
          <Button onClick={onEnable}>
            <Bell className="mr-1.5 h-4 w-4" />
            Ativar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
