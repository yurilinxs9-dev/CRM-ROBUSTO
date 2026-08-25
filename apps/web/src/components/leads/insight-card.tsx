'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

// ---------------------------------------------------------------------------
// Contrato da API (Task 4)
// ---------------------------------------------------------------------------

/**
 * `GET /api/leads/:id/insight` devolve a linha crua de `LeadInsight`. Quando a
 * ficha ainda nao foi gerada o service devolve `null`, e o Nest responde 200
 * com CORPO VAZIO — nao 404. Por isso a normalizacao trata os dois casos: corpo
 * vazio (`''`/`null`) e 404 viram o mesmo estado "ainda nao gerado".
 */
export interface InsightMemoriaFato {
  fato: string;
  quando_dito: string;
}

export interface LeadInsight {
  resumo: string;
  memoria: InsightMemoriaFato[];
  proxima_acao_at: string | null;
  proxima_acao_motivo: string;
  msg_sugerida: string;
  geracoes: number;
  updated_at: string;
}

/** `memoria` e coluna Json: pode vir com lixo de ficha antiga. Le tolerando. */
function lerMemoria(valor: unknown): InsightMemoriaFato[] {
  if (!Array.isArray(valor)) return [];
  const saida: InsightMemoriaFato[] = [];
  for (const item of valor) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const registro = item as Record<string, unknown>;
    if (typeof registro.fato !== 'string' || registro.fato.trim() === '') continue;
    saida.push({
      fato: registro.fato,
      quando_dito: typeof registro.quando_dito === 'string' ? registro.quando_dito : '',
    });
  }
  return saida;
}

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

/** Corpo cru -> ficha tipada, ou `null` quando ainda nao existe ficha. */
function normalizar(corpo: unknown): LeadInsight | null {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return null;
  const registro = corpo as Record<string, unknown>;
  const resumo = texto(registro.resumo);
  const memoria = lerMemoria(registro.memoria);
  const msg = texto(registro.msg_sugerida);
  // Linha existe mas o worker ainda nao escreveu nada de util: para o usuario
  // isso e o mesmo que "ainda nao gerado".
  if (resumo.trim() === '' && memoria.length === 0 && msg.trim() === '') return null;
  return {
    resumo,
    memoria,
    proxima_acao_at:
      typeof registro.proxima_acao_at === 'string' ? registro.proxima_acao_at : null,
    proxima_acao_motivo: texto(registro.proxima_acao_motivo),
    msg_sugerida: msg,
    geracoes: typeof registro.geracoes === 'number' ? registro.geracoes : 0,
    updated_at: texto(registro.updated_at),
  };
}

function statusDoErro(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

function mensagemDoErro(err: unknown): string | undefined {
  const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof msg === 'string' ? msg : undefined;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/**
 * A geracao e assincrona (fila + LLM local, de 30s a 2min) e nao emite
 * WebSocket. Em vez de inventar um canal so pra isso, o card faz polling leve
 * enquanto o drawer esta aberto: uma leitura por minuto de uma linha unica
 * indexada por `lead_id`. E o mesmo efeito de "invalidar depois de um tempo",
 * mas sem timer solto que sobrevive ao fechamento do drawer.
 */
const POLL_MS = 60 * 1000;

/** Mesmo rate limit do backend (429 por lead). Trava local = 0 clique inutil. */
const BLOQUEIO_REGERAR_MS = 5 * 60 * 1000;

/**
 * `POST /insight/refresh` exige @Roles(OPERADOR) e o RolesGuard e hierarquico —
 * so VISUALIZADOR fica de fora. Esconder o botao evita oferecer um 403.
 */
const PAPEIS_QUE_REGERAM = ['OPERADOR', 'GERENTE', 'SUPER_ADMIN'];

function formatarData(iso: string | null): string | null {
  if (!iso) return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface InsightCardProps {
  leadId: string;
  /**
   * Presente so onde existe composer (o chat): joga a mensagem sugerida na
   * caixa de texto. Sem ela (Kanban) o botao vira "Copiar".
   */
  onUsarMensagem?: (texto: string) => void;
  /** Desliga as queries quando o drawer esta fechado. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

/**
 * Card "Inteligencia": resumo, memoria e proxima acao da ficha do lead.
 *
 * TODO o conteudo aqui e texto gerado por LLM a partir do que o CLIENTE
 * escreveu. Por isso ele SO pode ser renderizado como texto React normal —
 * nada de `dangerouslySetInnerHTML` nem render de markdown, senao um cliente
 * consegue injetar HTML na tela do vendedor pelo WhatsApp.
 */
export function InsightCard({ leadId, onUsarMensagem, enabled = true }: InsightCardProps) {
  const queryClient = useQueryClient();
  const papel = useAuthStore((s) => s.user?.role);
  const podeRegerar = !!papel && PAPEIS_QUE_REGERAM.includes(papel);
  const [aberto, setAberto] = useState(true);
  /** Timestamp ate quando "Regenerar" fica travado. 0 = liberado. */
  const [bloqueadoAte, setBloqueadoAte] = useState(0);

  const {
    data: insight,
    isLoading,
    isError,
    error,
  } = useQuery<LeadInsight | null>({
    queryKey: ['lead-insight', leadId],
    queryFn: async () => {
      try {
        const res = await api.get(`/api/leads/${leadId}/insight`);
        return normalizar(res.data);
      } catch (err) {
        // Backend antigo (sem o modulo) ou lead sem ficha: mesmo estado vazio.
        if (statusDoErro(err) === 404) return null;
        throw err;
      }
    },
    enabled: enabled && !!leadId,
    retry: false,
    refetchInterval: POLL_MS,
  });

  // Libera o botao sozinho quando o bloqueio vence — sem isto o usuario
  // precisaria fechar e reabrir o drawer para o "Regenerar" voltar.
  useEffect(() => {
    if (bloqueadoAte === 0) return;
    const restante = bloqueadoAte - Date.now();
    if (restante <= 0) {
      setBloqueadoAte(0);
      return;
    }
    const id = window.setTimeout(() => setBloqueadoAte(0), restante);
    return () => window.clearTimeout(id);
  }, [bloqueadoAte]);

  const regerar = useMutation({
    mutationFn: async () => {
      await api.post(`/api/leads/${leadId}/insight/refresh`);
    },
    onSuccess: () => {
      setBloqueadoAte(Date.now() + BLOQUEIO_REGERAR_MS);
      toast.success('Na fila — a ficha fica pronta em alguns minutos.');
      void queryClient.invalidateQueries({ queryKey: ['lead-insight', leadId] });
    },
    onError: (err: unknown) => {
      const status = statusDoErro(err);
      if (status === 429) {
        // O backend tambem guarda o relogio; espelha a trava aqui para o
        // usuario nao ficar batendo no 429.
        setBloqueadoAte(Date.now() + BLOQUEIO_REGERAR_MS);
        toast.error(mensagemDoErro(err) ?? 'Ficha atualizada há pouco. Tente de novo em alguns minutos.');
        return;
      }
      if (status === 403) {
        toast.error('Você não tem permissão para regerar esta ficha.');
        return;
      }
      toast.error('Não foi possível pedir a regeração da ficha.');
    },
  });

  const bloqueado = bloqueadoAte > Date.now();
  const pedindo = regerar.isPending;

  const copiar = async (valor: string) => {
    try {
      await navigator.clipboard.writeText(valor);
      toast.success('Copiada');
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.');
    }
  };

  const proximaAcao = useMemo(
    () => formatarData(insight?.proxima_acao_at ?? null),
    [insight?.proxima_acao_at],
  );
  const atualizadaEm = useMemo(
    () => formatarData(insight?.updated_at ?? null),
    [insight?.updated_at],
  );

  const msg = insight?.msg_sugerida.trim() ?? '';

  return (
    <section className="rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {aberto ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Brain className="h-3.5 w-3.5" />
        Inteligência
      </button>

      {aberto && (
        <div className="space-y-3 px-3 pb-3">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : isError ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Não foi possível carregar a ficha inteligente
                {statusDoErro(error) ? ` (erro ${statusDoErro(error)})` : ''}. O resto da ficha do
                lead continua funcionando.
              </p>
            </div>
          ) : !insight ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Ainda não gerado. A ficha é montada automaticamente conforme a conversa avança.
              </p>
              {podeRegerar && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={pedindo || bloqueado}
                  onClick={() => regerar.mutate()}
                >
                  {pedindo ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  )}
                  {pedindo ? 'Enviando...' : 'Gerar agora'}
                </Button>
              )}
            </div>
          ) : (
            <>
              {insight.resumo.trim() !== '' && (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {insight.resumo}
                </p>
              )}

              {insight.memoria.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Memória
                  </p>
                  <ul className="space-y-0.5">
                    {insight.memoria.map((fato, i) => (
                      <li
                        key={`${i}-${fato.fato}`}
                        className="flex gap-1.5 text-xs leading-snug text-muted-foreground"
                      >
                        <span aria-hidden className="text-muted-foreground/60">
                          •
                        </span>
                        <span className="min-w-0 break-words">
                          <span className="text-foreground">{fato.fato}</span>
                          {fato.quando_dito.trim() !== '' && (
                            <span className="text-muted-foreground"> — {fato.quando_dito}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {proximaAcao && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-foreground">Próximo contato: {proximaAcao}</span>
                    {insight.proxima_acao_motivo.trim() !== '' && (
                      <span> — {insight.proxima_acao_motivo}</span>
                    )}
                  </span>
                </p>
              )}

              {msg !== '' && (
                <div className="space-y-2 rounded-md border bg-background px-2.5 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Mensagem sugerida
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{msg}</p>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      if (onUsarMensagem) onUsarMensagem(msg);
                      else void copiar(msg);
                    }}
                  >
                    {onUsarMensagem ? (
                      <Send className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <Copy className="mr-1 h-3.5 w-3.5" />
                    )}
                    {onUsarMensagem ? 'Usar' : 'Copiar'}
                  </Button>
                </div>
              )}

              {/* Fora do bloco da mensagem de proposito: ficha sem
                  `msg_sugerida` (modelo devolveu vazio) tambem precisa de um
                  caminho para pedir outra geracao. */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                {atualizadaEm ? (
                  <p className="text-[11px] text-muted-foreground">
                    Atualizada em {atualizadaEm}
                    {insight.geracoes > 0 ? ` · ${insight.geracoes} geração(ões)` : ''}
                  </p>
                ) : (
                  <span />
                )}
                {podeRegerar && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={pedindo || bloqueado}
                    title={
                      bloqueado
                        ? 'Ficha atualizada há pouco — disponível de novo em alguns minutos.'
                        : undefined
                    }
                    onClick={() => regerar.mutate()}
                  >
                    {pedindo ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    {pedindo ? 'Enviando...' : 'Regenerar'}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
