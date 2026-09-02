'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  aplicarMencao,
  extractMentionIds,
  sugerirMencoes,
  type MencionavelUser,
} from '@/lib/mentions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';

export interface NotaInternaComposerProps {
  leadId: string;
  disabled?: boolean;
  onCriada?: () => void;
  className?: string;
}

/**
 * O `@` so abre o autocomplete quando comeca palavra — no inicio do texto ou
 * depois de espaco/quebra de linha. Sem isso, digitar um e-mail (`fulano@is`)
 * abriria a lista de pessoas no meio do endereco.
 */
function mencaoComecaPalavra(textoAteCursor: string): boolean {
  const pos = textoAteCursor.lastIndexOf('@');
  if (pos < 0) return false;
  if (pos === 0) return true;
  return /\s/.test(textoAteCursor.charAt(pos - 1));
}

/**
 * Nota interna (so a equipe ve) com autocomplete de @mencao. Grava pelo mesmo
 * endpoint do chat; a nota aparece la e na timeline.
 */
export function NotaInternaComposer({
  leadId,
  disabled = false,
  onCriada,
  className,
}: NotaInternaComposerProps) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState('');
  const [cursor, setCursor] = useState(0);
  const [indice, setIndice] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const { data: equipe = [] } = useQuery<MencionavelUser[]>({
    queryKey: ['team-mention-users'],
    queryFn: async () => (await api.get<MencionavelUser[]>('/api/users/list')).data,
    staleTime: 5 * 60_000,
  });

  const textoAteCursor = texto.slice(0, cursor);
  const sugestao = mencaoComecaPalavra(textoAteCursor)
    ? sugerirMencoes(textoAteCursor, equipe)
    : null;
  const sugestoes = sugestao?.sugestoes.slice(0, 6) ?? [];

  const escolher = (u: MencionavelUser | undefined) => {
    if (!u) return;
    const r = aplicarMencao(texto.slice(0, cursor), texto.slice(cursor), u);
    setTexto(r.texto);
    setIndice(0);
    requestAnimationFrame(() => {
      areaRef.current?.focus();
      areaRef.current?.setSelectionRange(r.cursor, r.cursor);
      setCursor(r.cursor);
    });
  };

  const enviar = useMutation({
    mutationFn: async (content: string) =>
      (
        await api.post('/api/messages/internal-note', {
          lead_id: leadId,
          content,
          mentioned_user_ids: extractMentionIds(content, equipe),
        })
      ).data,
    onSuccess: () => {
      setTexto('');
      setCursor(0);
      void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['messages', leadId] });
      onCriada?.();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? 'Não foi possível salvar a nota');
    },
  });

  const submeter = () => {
    const t = texto.trim();
    if (!t || enviar.isPending) return;
    enviar.mutate(t);
  };

  return (
    <div className={cn('rounded-xl border border-amber-400/30 bg-amber-400/5 p-2', className)}>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
        <NotebookPen className="h-3 w-3" /> Nota interna · só a equipe vê
      </div>
      <div className="relative">
        <Textarea
          ref={areaRef}
          rows={2}
          disabled={disabled}
          className="min-h-0"
          placeholder="Escreva uma nota… use @ para mencionar alguém"
          value={texto}
          onChange={(e) => {
            setTexto(e.target.value);
            setCursor(e.target.selectionStart ?? e.target.value.length);
            setIndice(0);
          }}
          onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (sugestoes.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndice((i) => (i + 1) % sugestoes.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndice((i) => (i - 1 + sugestoes.length) % sugestoes.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                escolher(sugestoes[indice] ?? sugestoes[0]);
                return;
              }
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submeter();
            }
          }}
        />
        {sugestoes.length > 0 && (
          <ul className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border bg-popover p-1 shadow-md">
            {sugestoes.map((u, i) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded px-2 py-1 text-left text-sm',
                    i === indice && 'bg-accent',
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    escolher(u);
                  }}
                >
                  {u.nome}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">Ctrl+Enter envia</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || !texto.trim() || enviar.isPending}
          onClick={submeter}
        >
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {enviar.isPending ? 'Salvando…' : 'Salvar nota'}
        </Button>
      </div>
    </div>
  );
}
