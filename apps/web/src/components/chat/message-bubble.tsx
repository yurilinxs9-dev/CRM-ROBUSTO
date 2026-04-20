'use client';

import { memo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Download,
  FileText,
  MapPin,
  NotebookPen,
  Reply,
  User as UserIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { AudioMessage } from './audio-message';
import { ImagePreviewDialog } from './image-preview-dialog';
import { MediaImage } from './media-image';
import { ReactionsPopover } from './reactions-popover';
import { VideoBubble } from './video-bubble';
import {
  ChatMessage,
  MessageStatus,
  formatBytes,
  formatTime,
  isOutgoing as isOutgoingDir,
} from './types';

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

/** Fetch media via authenticated proxy and trigger browser download. */
async function downloadMediaViaProxy(messageId: string, filename: string) {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const res = await fetch(`/api/messages/${messageId}/media`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(`[Document] download failed for msg=${messageId}:`, err);
  }
}

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
          className="break-all underline underline-offset-2 hover:opacity-80"
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
      return <CheckCheck size={14} className="opacity-70" aria-label="Entregue" />;
    case 'READ':
      return <CheckCheck size={14} className="text-sky-500" aria-label="Lida" />;
    case 'FAILED':
      return (
        <AlertCircle size={14} className="text-destructive" aria-label="Falhou" />
      );
    default:
      return null;
  }
}

export interface MessageBubbleProps {
  message: ChatMessage;
  /** True if this is the first message of a sender sequence (tail corner). */
  isFirstInGroup?: boolean;
  onReply?: (message: ChatMessage) => void;
  onReact?: (message: ChatMessage, emoji: string) => void;
  reactions?: string[];
}

function MessageBubbleComponent({
  message,
  isFirstInGroup = true,
  onReply,
  onReact,
  reactions,
}: MessageBubbleProps) {
  const [imgOpen, setImgOpen] = useState(false);
  const outgoing = isOutgoingDir(message.direction);
  const note = message.is_internal_note;
  const type = (message.type ?? 'TEXT').toString().toUpperCase();

  if (note) {
    return (
      <div className="my-1.5 flex justify-center">
        <div className="max-w-[85%] rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2">
          <div className="flex items-start gap-2">
            <NotebookPen size={14} className="mt-0.5 flex-shrink-0 text-amber-500" />
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

  // Bubble shape: outgoing = WhatsApp green-ish; incoming = white card.
  // First-in-group gets the "tail" corner (squared on its origin side).
  const bubbleBase = cn(
    'relative max-w-[78%] rounded-2xl px-3 py-2 shadow-sm',
    outgoing
      ? 'bg-[#d9fdd3] text-foreground dark:bg-[#005c4b] dark:text-white'
      : 'border border-border bg-card text-foreground',
    outgoing && isFirstInGroup && 'rounded-tr-sm',
    !outgoing && isFirstInGroup && 'rounded-tl-sm',
  );

  const handleReply = () => {
    onReply?.(message);
  };

  const handleReact = (emoji: string) => {
    onReact?.(message, emoji);
  };

  return (
    <div
      className={cn(
        'group/msg relative my-0.5 flex',
        outgoing ? 'justify-end' : 'justify-start',
      )}
    >
      <div className={bubbleBase}>
        {/* Hover actions */}
        <div
          className={cn(
            'absolute top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100',
            outgoing ? '-left-16' : '-right-16',
          )}
        >
          {onReact && <ReactionsPopover onSelect={handleReact} />}
          {onReply && (
            <button
              type="button"
              onClick={handleReply}
              aria-label="Responder"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-sm transition hover:bg-card hover:text-foreground"
            >
              <Reply size={12} />
            </button>
          )}
        </div>

        {type === 'AUDIO' && message.media_url && (
          <AudioMessage
            messageId={message.id}
            src={message.media_url}
            isOutgoing={outgoing}
            waveformPeaks={message.media_waveform_peaks}
          />
        )}

        {type === 'IMAGE' && message.media_url && (
          <MediaImage
            messageId={message.id}
            signedUrl={message.media_url}
            alt={message.media_filename ?? 'Imagem'}
            onOpenPreview={() => setImgOpen(true)}
          />
        )}
        {type === 'IMAGE' && imgOpen && (
          <ImagePreviewDialog
            src={message.media_url ?? ''}
            alt={message.media_filename ?? 'Imagem'}
            open={imgOpen}
            onOpenChange={setImgOpen}
            messageId={message.id}
          />
        )}

        {type === 'VIDEO' && message.media_url && (
          <VideoBubble
            messageId={message.id}
            src={message.media_url}
            poster={message.media_poster_path}
            thumbnail={message.media_thumbnail_path}
          />
        )}

        {type === 'DOCUMENT' && message.media_url && (
          <button
            type="button"
            onClick={() => downloadMediaViaProxy(message.id, message.media_filename ?? 'documento')}
            className="flex min-w-[220px] items-center gap-3 rounded-lg bg-background/40 p-2 transition hover:bg-background/60"
          >
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <FileText size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-left">
                {message.media_filename ?? 'Documento'}
              </p>
              <p className="text-left text-[11px] text-muted-foreground">
                {formatBytes(message.media_size_bytes)}
              </p>
            </div>
            <Download size={16} className="flex-shrink-0 opacity-70" />
          </button>
        )}

        {type === 'STICKER' && message.media_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={message.media_url}
            alt="Sticker"
            width={128}
            height={128}
            loading="lazy"
            className="h-32 w-32 object-contain"
          />
        )}

        {/* Fallback for media messages with no URL (old messages before fix) */}
        {['AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT', 'STICKER'].includes(type) &&
          !message.media_url && (
            <div className="flex min-w-[180px] items-center gap-2 text-xs opacity-70">
              <AlertCircle size={14} />
              <span>Mídia não disponível</span>
            </div>
          )}

        {type === 'LOCATION' && (
          <div className="flex min-w-[220px] items-center gap-3 rounded-lg bg-background/40 p-2">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <MapPin size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">Localização</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {message.content ?? 'Compartilhada via WhatsApp'}
              </p>
            </div>
          </div>
        )}

        {type === 'CONTACT' && (
          <div className="flex min-w-[220px] items-center gap-3 rounded-lg bg-background/40 p-2">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <UserIcon size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {message.content ?? 'Contato'}
              </p>
              <p className="text-[11px] text-muted-foreground">Cartão de contato</p>
            </div>
          </div>
        )}

        {(type === 'TEXT' ||
          !['AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACT'].includes(type)) && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {renderText(message.content ?? '')}
          </p>
        )}

        {(type === 'IMAGE' || type === 'VIDEO') && message.content && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {renderText(message.content)}
          </p>
        )}

        {reactions && reactions.length > 0 && (
          <div
            className={cn(
              'absolute -bottom-3 flex items-center gap-0.5 rounded-full border border-border bg-card px-1.5 py-0.5 text-xs shadow-sm',
              outgoing ? 'right-2' : 'left-2',
            )}
          >
            {reactions.map((r, i) => (
              <span key={`${r}-${i}`}>{r}</span>
            ))}
          </div>
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

export const MessageBubble = memo(MessageBubbleComponent);
