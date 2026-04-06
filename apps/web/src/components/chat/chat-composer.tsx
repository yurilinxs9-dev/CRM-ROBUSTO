'use client';

import {
  ChangeEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Check,
  FileText,
  Image as ImageIcon,
  Mic,
  NotebookPen,
  Paperclip,
  Send,
  Smile,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/cn';

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🥳',
  '😉','😇','🙂','🙃','😌','😴','🤤','😋','🤔','🫶',
  '👍','👎','👏','🙏','💪','🔥','✨','🎉','❤️','💔',
];

interface ChatComposerProps {
  disabled?: boolean;
  sending?: boolean;
  onSendText: (content: string, isInternalNote: boolean) => void;
  onSendAudio: (blob: Blob, durationSec: number) => void;
  onSendMedia: (file: File, caption: string | undefined) => void;
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ChatComposer({
  disabled,
  sending,
  onSendText,
  onSendAudio,
  onSendMedia,
}: ChatComposerProps) {
  const [text, setText] = useState('');
  const [isNote, setIsNote] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Recording state
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelRef = useRef(false);

  // File inputs
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  };

  const handleSendText = useCallback(() => {
    const content = text.trim();
    if (!content) return;
    onSendText(content, isNote);
    setText('');
    setTimeout(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }, 0);
  }, [text, isNote, onSendText]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  };

  const insertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
    setEmojiOpen(false);
    textareaRef.current?.focus();
  };

  // --- Recording ---
  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (recording || disabled) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      cancelRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stopStream();
        clearTimer();
        const capturedDuration = duration;
        if (cancelRef.current) {
          chunksRef.current = [];
          return;
        }
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || 'audio/webm',
        });
        chunksRef.current = [];
        if (blob.size > 0) {
          onSendAudio(blob, capturedDuration);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setDuration(0);
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (err) {
      console.error('[recorder] getUserMedia failed', err);
      alert('Não foi possível acessar o microfone.');
      stopStream();
    }
  };

  const stopAndSend = () => {
    if (!recorderRef.current) return;
    cancelRef.current = false;
    recorderRef.current.stop();
    setRecording(false);
  };

  const cancelRecording = () => {
    if (!recorderRef.current) return;
    cancelRef.current = true;
    try {
      recorderRef.current.stop();
    } catch {
      /* noop */
    }
    setRecording(false);
    setDuration(0);
  };

  useEffect(() => {
    return () => {
      clearTimer();
      stopStream();
    };
  }, []);

  // --- Media uploads ---
  const triggerUpload = (kind: 'image' | 'video' | 'document') => {
    if (kind === 'image') imageInputRef.current?.click();
    if (kind === 'video') videoInputRef.current?.click();
    if (kind === 'document') docInputRef.current?.click();
  };

  const handleFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const caption = text.trim() || undefined;
    onSendMedia(file, caption);
    if (caption) setText('');
  };

  const canSendText = text.trim().length > 0;

  return (
    <div
      className={cn(
        'sticky bottom-0 border-t bg-card',
        isNote && 'border-amber-400/30 bg-amber-400/5',
      )}
    >
      {isNote && !recording && (
        <div className="flex items-center gap-2 border-b border-amber-400/20 px-4 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <NotebookPen size={12} />
          <span className="font-medium">Modo nota interna</span>
          <span className="text-muted-foreground">
            — não será enviada ao cliente
          </span>
        </div>
      )}

      {recording ? (
        <div className="flex items-center gap-3 px-3 py-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cancelar gravação"
            onClick={cancelRecording}
            className="h-10 w-10 text-destructive"
          >
            <Trash2 size={18} />
          </Button>

          <div className="flex flex-1 items-center gap-3 rounded-full bg-muted/60 px-4 py-2">
            <span className="relative flex h-3 w-3 flex-shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
            <span className="text-sm font-mono tabular-nums text-foreground">
              {formatTimer(duration)}
            </span>
            <div className="flex flex-1 items-center gap-0.5 overflow-hidden">
              {Array.from({ length: 30 }).map((_, i) => (
                <span
                  key={i}
                  className="h-4 w-0.5 animate-pulse rounded-full bg-primary/60"
                  // eslint-disable-next-line react/forbid-dom-props
                />
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">Gravando…</span>
          </div>

          <Button
            type="button"
            size="icon"
            aria-label="Enviar áudio"
            onClick={stopAndSend}
            className="h-10 w-10 rounded-full"
          >
            <Check size={18} />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2 px-3 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Alternar nota interna"
            onClick={() => setIsNote((v) => !v)}
            className={cn(
              'h-10 w-10 flex-shrink-0',
              isNote && 'bg-amber-400/20 text-amber-500 hover:bg-amber-400/30',
            )}
            title="Nota interna"
          >
            <NotebookPen size={18} />
          </Button>

          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Emojis"
                className="h-10 w-10 flex-shrink-0"
              >
                <Smile size={18} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-2">
              <div className="grid grid-cols-6 gap-1">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => insertEmoji(e)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-muted"
                    aria-label={`emoji ${e}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Anexar arquivo"
                className="h-10 w-10 flex-shrink-0"
              >
                <Paperclip size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => triggerUpload('image')}>
                <ImageIcon size={14} className="mr-2" />
                Imagem
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => triggerUpload('video')}>
                <Video size={14} className="mr-2" />
                Vídeo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => triggerUpload('document')}>
                <FileText size={14} className="mr-2" />
                Documento
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFilePicked}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={handleFilePicked}
          />
          <input
            ref={docInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar"
            className="hidden"
            onChange={handleFilePicked}
          />

          <div className="flex-1">
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={isNote ? 'Escrever nota interna…' : 'Mensagem'}
              aria-label="Mensagem"
              disabled={disabled}
              className={cn(
                'w-full resize-none rounded-2xl border border-border bg-background px-4 py-2.5 text-sm leading-5 outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/20',
                isNote && 'italic',
              )}
            />
          </div>

          {canSendText ? (
            <Button
              type="button"
              size="icon"
              aria-label="Enviar mensagem"
              onClick={handleSendText}
              disabled={disabled || sending}
              className="h-10 w-10 flex-shrink-0 rounded-full"
            >
              <Send size={18} />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              aria-label="Gravar áudio"
              variant="default"
              onClick={startRecording}
              disabled={disabled}
              className="h-10 w-10 flex-shrink-0 rounded-full"
            >
              <Mic size={18} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
