'use client';

import { useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Download,
  FileText,
  NotebookPen,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { AudioMessage } from './audio-message';
import {
  ChatMessage,
  MessageStatus,
  formatBytes,
  formatTime,
  isOutgoing as isOutgoingDir,
} from './types';

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

function renderText(text: string) {
  const parts = text.split(URL_REGEX);
  return parts.map((part, i) => {
    if (URL_REGEX.test(part)) {
      URL_REGEX.lastIndex = 0;
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 break-all hover:opacity-80"
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function StatusIcon({ status }: { status: MessageStatus }) {
  switch (status) {
    case 'PENDING':
      return <Clock size={14} className="opacity-70" aria-label="Pendente" />;
    case 'SENT':
      return <Check size={14} className="opacity-70" aria-label="Enviada" />;
    case 'DELIVERED':
      return (
        <CheckCheck size={14} className="opacity-70" aria-label="Entregue" />
      );
    case 'READ':
      return (
        <CheckCheck
          size={14}
          className="text-sky-500"
          aria-label="Lida"
        />
      );
    case 'FAILED':
      return (
        <AlertCircle
          size={14}
          className="text-destructive"
          aria-label="Falhou"
        />
      );
    default:
      return null;
  }
}

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const [imgOpen, setImgOpen] = useState(false);
  const outgoing = isOutgoingDir(message.direction);
  const note = message.is_internal_note;
  const type = (message.type ?? 'TEXT').toString().toUpperCase();

  if (note) {
    return (
      <div className="my-1.5 flex justify-center">
        <div className="max-w-[85%] rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2">
          <div className="flex items-start gap-2">
            <NotebookPen size={14} className="mt-0.5 text-amber-500 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-500">
                Nota interna
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm italic text-foreground/90">
                {message.content}
              </p>
              <p className="mt-1 text-right text-[10px] text-muted-foreground">
                {formatTime(message.created_at)}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const bubbleBase = cn(
    'relative max-w-[78%] rounded-2xl px-3 py-2 shadow-sm',
    outgoing
      ? 'rounded-br-sm bg-primary/15 text-foreground'
      : 'rounded-bl-sm border border-border bg-card text-foreground',
  );

  return (
    <div className={cn('my-0.5 flex', outgoing ? 'justify-end' : 'justify-start')}>
      <div className={bubbleBase}>
        {type === 'AUDIO' && message.media_url && (
          <AudioMessage src={message.media_url} isOutgoing={outgoing} />
        )}

        {type === 'IMAGE' && message.media_url && (
          <Dialog open={imgOpen} onOpenChange={setImgOpen}>
            <DialogTrigger asChild>
              <button
                type="button"
                className="block overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label="Abrir imagem"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={message.media_url}
                  alt={message.media_filename ?? 'Imagem'}
                  className="max-h-72 max-w-xs object-cover"
                />
              </button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={message.media_url}
                alt={message.media_filename ?? 'Imagem'}
                className="h-auto w-full rounded-md"
              />
            </DialogContent>
          </Dialog>
        )}

        {type === 'VIDEO' && message.media_url && (
          <video
            src={message.media_url}
            controls
            className="max-h-80 max-w-xs rounded-lg"
          />
        )}

        {type === 'DOCUMENT' && message.media_url && (
          <a
            href={message.media_url}
            target="_blank"
            rel="noopener noreferrer"
            download={message.media_filename ?? undefined}
            className="flex min-w-[220px] items-center gap-3 rounded-lg bg-background/40 p-2 transition hover:bg-background/60"
          >
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <FileText size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {message.media_filename ?? 'Documento'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {formatBytes(message.media_size_bytes)}
              </p>
            </div>
            <Download size={16} className="flex-shrink-0 opacity-70" />
          </a>
        )}

        {(type === 'TEXT' || !['AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(type)) && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {renderText(message.content ?? '')}
          </p>
        )}

        {(type === 'IMAGE' || type === 'VIDEO') && message.content && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {renderText(message.content)}
          </p>
        )}

        <div
          className={cn(
            'mt-1 flex items-center gap-1 text-[10px] text-muted-foreground',
            outgoing ? 'justify-end' : 'justify-start',
          )}
        >
          <span>{formatTime(message.created_at)}</span>
          {outgoing && <StatusIcon status={message.status} />}
        </div>
      </div>
    </div>
  );
}
