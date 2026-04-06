'use client';

import { MessageCircle, QrCode, RotateCcw, Trash2, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export interface InstanceCardData {
  id: string;
  nome: string;
  telefone?: string | null;
  status: string;
  ultimo_check?: string | null;
}

type StatusKind = 'connected' | 'connecting' | 'disconnected';

function resolveStatus(status: string): { kind: StatusKind; label: string } {
  if (status === 'open' || status === 'connected') return { kind: 'connected', label: 'Conectado' };
  if (status === 'connecting') return { kind: 'connecting', label: 'Conectando' };
  return { kind: 'disconnected', label: 'Desconectado' };
}

interface Props {
  instance: InstanceCardData;
  onConnect: (nome: string) => void;
  onReconnect: (nome: string) => void;
  onDelete: (nome: string) => void;
  reconnecting?: boolean;
}

export function InstanceCard({ instance, onConnect, onReconnect, onDelete, reconnecting }: Props) {
  const status = resolveStatus(instance.status);

  const badge =
    status.kind === 'connected' ? (
      <Badge variant="success">{status.label}</Badge>
    ) : status.kind === 'connecting' ? (
      <Badge variant="warning" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        {status.label}
      </Badge>
    ) : (
      <Badge variant="destructive">{status.label}</Badge>
    );

  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{instance.nome}</p>
              {instance.telefone && status.kind === 'connected' ? (
                <p className="text-xs text-muted-foreground truncate">{instance.telefone}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Sem telefone vinculado</p>
              )}
            </div>
          </div>
          {badge}
        </div>

        <p className="text-xs text-muted-foreground">
          {instance.ultimo_check
            ? `Verificado ${formatDistanceToNow(new Date(instance.ultimo_check), { addSuffix: true, locale: ptBR })}`
            : 'Sem verificação recente'}
        </p>

        <div className="flex items-center gap-2 pt-1">
          {status.kind === 'disconnected' && (
            <Button size="sm" className="flex-1" onClick={() => onConnect(instance.nome)}>
              <QrCode className="mr-1.5 h-3.5 w-3.5" />
              Conectar
            </Button>
          )}
          {status.kind === 'connecting' && (
            <Button size="sm" variant="outline" className="flex-1" onClick={() => onConnect(instance.nome)}>
              <QrCode className="mr-1.5 h-3.5 w-3.5" />
              Ver QR
            </Button>
          )}
          {status.kind === 'connected' && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => onReconnect(instance.nome)}
              disabled={reconnecting}
            >
              {reconnecting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Reconectar
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(instance.nome)}
            aria-label="Excluir instância"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
