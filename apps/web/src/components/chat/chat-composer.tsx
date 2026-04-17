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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ReplyPreview, type ReplyTarget } from './reply-preview';

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🥳',
  '😉','😇','🙂','🙃','😌','😴','🤤','😋','🤔','🫶',
  '👍','👎','👏','🙏','💪','🔥','✨','🎉','❤️','💔',
];

interface ChatComposerProps {
  disabled?: boolean;
  sending?: boolean;
  /** Resets state (focus, text) when this key changes — e.g. conversation id. */
  conversationKey?: string;
  replyTarget?: ReplyTarget | null;
  onCancelReply?: () => void;
  onSendText: (content: string, isInternalNote: boolean) => void;
  onSendAudio: (blob: Blob, durationSec: number, waveformPeaks?: number[]) => void;
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
  conversationKey,
  replyTarget,
  onCancelReply,
  onSendText,
  onSendAudio,
  onSendMedia,
}: ChatComposerProps) {
  const [text, setText] = useState('');
  const [isNote, setIsNote] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Image caption preview dialog state.
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [pendingCaption, setPendingCaption] = useState('');

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus when switching conversation.
  useEffect(() => {
    if (disabled) return;
    const id = window.setTimeout(() => textareaRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [conversationKey, disabled]);

  // Recording state
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [waveformBars, setWaveformBars] = useState<number[]>(() =>
    Array.from({ length: 30 }, () => 0),
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);

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
    // Reply quoting: backend doesn't yet support structured replies, so we
    // prefix the content visually. Frontend reply state is cleared on send.
    const finalContent = replyTarget
      ? `> ${replyTarget.author}: ${replyTarget.preview}\n\n${content}`
      : content;
    onSendText(finalContent, isNote);
    setText('');
    onCancelReply?.();
    setTimeout(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }, 0);
  }, [text, isNote, onSendText, replyTarget, onCancelReply]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSendText();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
      return;
    }
    if (e.key === 'Escape') {
      if (recording) {
        e.preventDefault();
        cancelRecording();
      } else if (replyTarget) {
        e.preventDefault();
        onCancelReply?.();
      }
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

  const cleanupAnalyser = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    analyserRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  };

  const computePeaks = async (blob: Blob): Promise<number[]> => {
    try {
      const ctx = new AudioContext();
      const arrayBuf = await blob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuf);
      const raw = audioBuffer.getChannelData(0);
      const peakCount = 40;
      const segLen = Math.floor(raw.length / peakCount);
      const peaks: number[] = [];
      for (let i = 0; i < peakCount; i++) {
        let sum = 0;
        const start = i * segLen;
        const end = Math.min(start + segLen, raw.length);
        for (let j = start; j < end; j++) {
          sum += raw[j] * raw[j];
        }
        peaks.push(Math.sqrt(sum / (end - start)));
      }
      const max = Math.max(...peaks, 0.001);
      await ctx.close();
      return peaks.map((p) => Math.round((p / max) * 100) / 100);
    } catch {
      return [];
    }
  };

  const startRecording = async () => {
    if (recording || disabled) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Setup AudioContext + AnalyserNode for live waveform
      const actx = new AudioContext();
      const source = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = actx;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(dataArray);
        // Compute RMS for 30 segments of the time-domain buffer
        const segLen = Math.floor(dataArray.length / 30);
        const bars: number[] = [];
        for (let i = 0; i < 30; i++) {
          let sum = 0;
          for (let j = 0; j < segLen; j++) {
            const v = (dataArray[i * segLen + j] - 128) / 128;
            sum += v * v;
          }
          bars.push(Math.sqrt(sum / segLen));
        }
        setWaveformBars(bars);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);

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
        cleanupAnalyser();
        setWaveformBars(Array.from({ length: 30 }, () => 0));
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
          computePeaks(blob).then((peaks) => {
            onSendAudio(blob, capturedDuration, peaks.length > 0 ? peaks : undefined);
          });
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
      cleanupAnalyser();
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
    cleanupAnalyser();
    setWaveformBars(Array.from({ length: 30 }, () => 0));
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
      cleanupAnalyser();
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
    // Images: open preview dialog with optional caption.
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setPendingImage(file);
      setPendingPreview(url);
      setPendingCaption(text.trim());
      return;
    }
    const caption = text.trim() || undefined;
    onSendMedia(file, caption);
    if (caption) setText('');
  };

  const clearPendingImage = useCallback(() => {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingImage(null);
    setPendingPreview(null);
    setPendingCaption('');
  }, [pendingPreview]);

  const confirmPendingImage = () => {
    if (!pendingImage) return;
    const caption = pendingCaption.trim() || undefined;
    onSendMedia(pendingImage, caption);
    if (text.trim() === pendingCaption.trim()) setText('');
    clearPendingImage();
  };

  const canSendText = text.trim().length > 0;

  return (
    <div
      className={cn(
        'sticky bottom-0 border-t bg-card',
        isNote && 'border-amber-400/30 bg-amber-400/5',
      )}
    >
      {replyTarget && !recording && onCancelReply && (
        <ReplyPreview target={replyTarget} onCancel={onCancelReply} />
      )}

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
              {waveformBars.map((level, i) => (
                <span
                  key={i}
                  className="w-0.5 rounded-full bg-primary/60 transition-[height] duration-75"
                  style={{ height: `${Math.max(2, level * 24)}px` }}
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

      <Dialog
        open={!!pendingImage}
        onOpenChange={(v) => {
          if (!v) clearPendingImage();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Enviar imagem</DialogTitle>
          </DialogHeader>
          {pendingPreview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pendingPreview}
              alt="Pré-visualização"
              className="max-h-[50vh] w-full rounded-md object-contain"
            />
          )}
          <textarea
            value={pendingCaption}
            onChange={(e) => setPendingCaption(e.target.value)}
            placeholder="Legenda (opcional)"
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          />
          <DialogFooter>
            <Button variant="outline" onClick={clearPendingImage}>
              Cancelar
            </Button>
            <Button onClick={confirmPendingImage} disabled={sending}>
              <Send size={14} className="mr-1.5" />
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
