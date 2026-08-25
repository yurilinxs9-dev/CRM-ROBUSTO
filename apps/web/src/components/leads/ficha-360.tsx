'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TEMP_BADGE, TEMP_LABELS, formatPhone } from '@/components/kanban/lead-card';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/auth.store';

// ---------------------------------------------------------------------------
// Contrato da API
// ---------------------------------------------------------------------------

/**
 * `GET /api/leads/:id/insight` devolve a LINHA CRUA de `LeadInsight`. Quando a
 * ficha ainda nao foi gerada o service devolve `null`, e o Nest responde 200
 * com CORPO VAZIO — nao 404. Por isso a normalizacao trata os dois casos: corpo
 * vazio (`''`/`null`) e 404 viram o mesmo estado "ainda nao gerado".
 */
export interface InsightMemoriaFato {
  fato: string;
  quando_dito: string;
}

/** `ultima_compra` e coluna Json: `{ descricao, valor, quando } | null`. */
export interface InsightCompra {
  descricao: string;
  /** `null` quando o cliente citou a compra mas nao o preco. */
  valor: number | null;
  quando: string;
}

export interface LeadInsight {
  resumo: string;
  memoria: InsightMemoriaFato[];
  proxima_acao_at: string | null;
  proxima_acao_motivo: string;
  msg_sugerida: string;
  /** 0 a 10; `null` quando o modelo nao avaliou o atendimento. */
  nota_atendimento: number | null;
  nota_ponto_forte: string;
  nota_ponto_melhoria: string;
  ultima_compra: InsightCompra | null;
  geracoes: number;
  updated_at: string;
}

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

/** `memoria` e coluna Json: pode vir com lixo de ficha antiga. Le tolerando. */
function lerMemoria(valor: unknown): InsightMemoriaFato[] {
  if (!Array.isArray(valor)) return [];
  const saida: InsightMemoriaFato[] = [];
  for (const item of valor) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const registro = item as Record<string, unknown>;
    if (typeof registro.fato !== 'string' || registro.fato.trim() === '') continue;
    saida.push({ fato: registro.fato, quando_dito: texto(registro.quando_dito) });
  }
  return saida;
}

/**
 * Compra sem descricao nao e compra: o bloco inteiro some. `valor` so vale
 * numero FINITO — Json cru aceita string, null e ate `1e999` (que o JSON.parse
 * transforma em Infinity), e nenhum desses formata como dinheiro.
 */
function lerCompra(valor: unknown): InsightCompra | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
  const registro = valor as Record<string, unknown>;
  const descricao = texto(registro.descricao).trim();
  if (descricao === '') return null;
  const bruto = registro.valor;
  return {
    descricao,
    valor: typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : null,
    quando: texto(registro.quando).trim(),
  };
}

/** Nota so vale inteiro dentro de 0..10 — fora disso o quadrado nao e mostrado. */
function lerNota(valor: unknown): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  const inteiro = Math.round(valor);
  if (inteiro < 0 || inteiro > 10) return null;
  return inteiro;
}

/** Corpo cru -> ficha tipada, ou `null` quando ainda nao existe ficha. */
function normalizar(corpo: unknown): LeadInsight | null {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return null;
  const registro = corpo as Record<string, unknown>;
  const resumo = texto(registro.resumo);
  const memoria = lerMemoria(registro.memoria);
  const msg = texto(registro.msg_sugerida);
  const nota = lerNota(registro.nota_atendimento);
  const compra = lerCompra(registro.ultima_compra);
  const pontoForte = texto(registro.nota_ponto_forte);
  const pontoMelhoria = texto(registro.nota_ponto_melhoria);
  // Linha existe mas o worker ainda nao escreveu nada de util: para o usuario
  // isso e o mesmo que "ainda nao gerado". Nota e compra entram na conta —
  // uma ficha que so avaliou o atendimento ainda tem o que mostrar.
  const vazia =
    resumo.trim() === '' &&
    memoria.length === 0 &&
    msg.trim() === '' &&
    nota === null &&
    compra === null &&
    pontoForte.trim() === '' &&
    pontoMelhoria.trim() === '';
  if (vazia) return null;
  return {
    resumo,
    memoria,
    proxima_acao_at:
      typeof registro.proxima_acao_at === 'string' ? registro.proxima_acao_at : null,
    proxima_acao_motivo: texto(registro.proxima_acao_motivo),
    msg_sugerida: msg,
    nota_atendimento: nota,
    nota_ponto_forte: pontoForte,
    nota_ponto_melhoria: pontoMelhoria,
    ultima_compra: compra,
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
 * A geracao e assincrona (fila + LLM, de 30s a 2min) e nao emite WebSocket. Em
 * vez de inventar um canal so pra isso, a ficha faz polling leve enquanto esta
 * na tela: uma leitura por minuto de uma linha unica indexada por `lead_id`.
 */
const POLL_MS = 60 * 1000;

/** Mesmo rate limit do backend (429 por lead). Trava local = 0 clique inutil. */
const BLOQUEIO_REGERAR_MS = 5 * 60 * 1000;

/**
 * `POST /insight/refresh` exige @Roles(OPERADOR) e o RolesGuard e hierarquico —
 * so VISUALIZADOR fica de fora. Esconder o botao evita oferecer um 403.
 */
const PAPEIS_QUE_REGERAM = ['OPERADOR', 'GERENTE', 'SUPER_ADMIN'];

const DIA_MS = 24 * 60 * 60 * 1000;

/** Mesmos cortes do radar do backend (`lead-insights.service.ts`). */
const PROMISSOR_DIAS = 2;
const ESFRIANDO_DIAS = 7;
const TEMPERATURAS_QUENTES = ['QUENTE', 'MUITO_QUENTE'];

/** A partir daqui "sem contato" vira alerta ambar na linha k/v. */
const DIAS_ALERTA = 7;

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------------------------------------------------------------------------
// Formatacao
// ---------------------------------------------------------------------------

function formatarData(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Dias inteiros parados. `null` = nunca houve interacao registrada. */
function diasParado(iso: string | null | undefined, agora: number): number | null {
  if (!iso) return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return Math.max(0, Math.floor((agora - data.getTime()) / DIA_MS));
}

/**
 * `temperatura` chega como string solta — pode ser valor novo do enum ou uma
 * chave do prototipo (`constructor`). Checa o TIPO do resultado em vez de
 * confiar no indice: chave herdada devolve funcao, e funcao viraria
 * `class="[object Function]"` no `cn`.
 */
function buscarTexto(mapa: Record<string, string>, chave: string): string | null {
  const valor: unknown = mapa[chave];
  return typeof valor === 'string' ? valor : null;
}

function iniciais(nome: string): string {
  const partes = nome.split(' ').filter(Boolean).slice(0, 2);
  if (partes.length === 0) return '?';
  return partes.map((p) => p[0]).join('').toUpperCase();
}

// ---------------------------------------------------------------------------
// Classificacao derivada
// ---------------------------------------------------------------------------

export type ClassificacaoLead = 'chamar_hoje' | 'promissor' | 'esfriando' | null;

export interface ClassificarLeadEntrada {
  temperatura: string;
  proxima_acao_at?: string | null;
  ultima_interacao?: string | null;
  /** Injetavel para teste; padrao e o relogio do navegador. */
  agora?: number;
}

/**
 * Badge derivado da ficha, com a MESMA precedencia do radar do backend:
 * chamar hoje > promissor > esfriando. Funcao pura de proposito — e a unica
 * regra de negocio da tela e precisa poder ser testada sem React.
 */
export function classificarLead({
  temperatura,
  proxima_acao_at,
  ultima_interacao,
  agora = Date.now(),
}: ClassificarLeadEntrada): ClassificacaoLead {
  if (proxima_acao_at) {
    const marcada = new Date(proxima_acao_at);
    // Acao marcada que ja venceu e o sinal mais forte: ganha de tudo.
    if (!Number.isNaN(marcada.getTime()) && marcada.getTime() <= agora) return 'chamar_hoje';
  }
  const dias = diasParado(ultima_interacao, agora);
  if (dias === null) return null;
  if (TEMPERATURAS_QUENTES.includes(temperatura) && dias >= PROMISSOR_DIAS) return 'promissor';
  if (dias >= ESFRIANDO_DIAS) return 'esfriando';
  return null;
}

const ROTULO_CLASSIFICACAO: Record<Exclude<ClassificacaoLead, null>, string> = {
  chamar_hoje: 'Chamar hoje',
  promissor: 'Promissor',
  esfriando: 'Esfriando',
};

// ---------------------------------------------------------------------------
// Blocos visuais
// ---------------------------------------------------------------------------

const PILULA = 'rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide';
const PILULA_ETAPA = 'border-blue-500/50 bg-blue-500/10 text-blue-300';
const PILULA_CLASSIFICACAO = 'border-orange-500/50 bg-orange-500/10 text-orange-300';

/** Cabecalho small-caps das secoes — a assinatura visual da ficha. */
function Secao({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'mt-4 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * Linha rotulo/valor. Sem `children` a linha inteira some — assim quem chama
 * nao precisa repetir a condicao em cada campo opcional.
 */
function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/5 py-[10px]">
      <dt className="shrink-0 text-sm text-muted-foreground">{rotulo}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-semibold">{children}</dd>
    </div>
  );
}

/** Verde >= 8, ambar 5-7, vermelho < 5 — a leitura e instantanea. */
function corDaNota(nota: number): string {
  if (nota >= 8) return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  if (nota >= 5) return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  return 'border-red-500/40 bg-red-500/10 text-red-300';
}

function EsqueletoFicha() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-2.5 w-40" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-2.5 w-48" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-3/4" />
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** O que a tela que abre a ficha JA tem em maos — evita um fetch extra. */
export interface Ficha360Lead {
  nome: string;
  telefone: string | null;
  etapa: string;
  temperatura: string;
  valor_estimado: number | null;
  ultima_interacao: string | null;
  responsavel?: string | null;
  tags?: string[];
  proxima_acao_at?: string | null;
}

export interface Ficha360Props {
  leadId: string;
  lead: Ficha360Lead;
  /**
   * Presente so onde existe composer (o chat): joga a mensagem sugerida na
   * caixa de texto. Sem ela o botao principal vira "Copiar".
   */
  onUsarMensagem?: (texto: string) => void;
  /**
   * Desliga a query quando a ficha nao esta visivel (drawer fechado, card do
   * radar recolhido). E o que torna a expansao do radar realmente lazy.
   */
  enabled?: boolean;
  /**
   * `false` onde a tela ao redor JA mostra nome/telefone (o cabecalho do
   * drawer): sobra so a fileira de badges, sem repetir a identidade do lead.
   */
  mostrarCabecalho?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

/**
 * Ficha 360 do lead: identidade, dados duros, o que a IA leu da conversa,
 * memoria do relacionamento, ultima compra, nota do atendimento e a sugestao
 * de proxima mensagem.
 *
 * TODO o conteudo vindo da IA (resumo, fatos, mensagem, pontos da nota,
 * descricao da compra) e texto gerado a partir do que o CLIENTE escreveu. Por
 * isso ele SO pode ser renderizado como texto React normal — nada de
 * `dangerouslySetInnerHTML` nem render de markdown, senao um cliente consegue
 * injetar HTML na tela do vendedor pelo WhatsApp.
 */
export function Ficha360({
  leadId,
  lead,
  onUsarMensagem,
  enabled = true,
  mostrarCabecalho = true,
  className,
}: Ficha360Props) {
  const queryClient = useQueryClient();
  const papel = useAuthStore((s) => s.user?.role);
  const podeRegerar = !!papel && PAPEIS_QUE_REGERAM.includes(papel);
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
  // precisaria fechar e reabrir a ficha para o "Regenerar" voltar.
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
        toast.error(
          mensagemDoErro(err) ?? 'Ficha atualizada há pouco. Tente de novo em alguns minutos.',
        );
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
      toast.success('Mensagem copiada');
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.');
    }
  };

  // A proxima acao da ficha e mais nova que a do lead carregado pela tela;
  // quando existe, manda nela (inclusive para classificar o badge).
  const proximaAcaoAt = insight?.proxima_acao_at ?? lead.proxima_acao_at ?? null;

  const classificacao = useMemo(
    () =>
      classificarLead({
        temperatura: lead.temperatura,
        proxima_acao_at: proximaAcaoAt,
        ultima_interacao: lead.ultima_interacao,
      }),
    [lead.temperatura, lead.ultima_interacao, proximaAcaoAt],
  );

  const dias = useMemo(
    () => diasParado(lead.ultima_interacao, Date.now()),
    [lead.ultima_interacao],
  );
  const proximaAcao = formatarData(proximaAcaoAt);
  const atualizadaEm = formatarData(insight?.updated_at);

  const temperaturaRotulo = buscarTexto(TEMP_LABELS, lead.temperatura) ?? lead.temperatura.trim();
  const temperaturaClasse =
    buscarTexto(TEMP_BADGE, lead.temperatura) ?? buscarTexto(TEMP_BADGE, '_DEFAULT') ?? '';

  /**
   * `undefined` = a tela nao sabe quem responde (nao passou o campo) e a linha
   * some; `null`/vazio = o backend disse que ninguem responde (pool), e isso e
   * informacao — vira "Sem dono".
   */
  const responsavel: ReactNode =
    lead.responsavel === undefined ? null : lead.responsavel?.trim() ? (
      lead.responsavel
    ) : (
      <span className="font-normal text-muted-foreground">Sem dono</span>
    );

  const tags = lead.tags?.filter((t) => t.trim() !== '') ?? [];
  const msg = insight?.msg_sugerida.trim() ?? '';
  const nota = insight?.nota_atendimento ?? null;
  const pontoForte = insight?.nota_ponto_forte.trim() ?? '';
  const pontoMelhoria = insight?.nota_ponto_melhoria.trim() ?? '';
  // Nota e textos sao INDEPENDENTES: a secao aparece se qualquer um existir.
  const temNota = nota !== null || pontoForte !== '' || pontoMelhoria !== '';
  const compra = insight?.ultima_compra ?? null;

  const etapa = lead.etapa.trim();
  /** `null` quando o lead nao tem etapa nem classificacao: a fileira some. */
  const badges: ReactNode =
    etapa === '' && classificacao === null ? null : (
      <>
        {etapa !== '' && <span className={cn(PILULA, PILULA_ETAPA)}>{etapa}</span>}
        {classificacao && (
          <span className={cn(PILULA, PILULA_CLASSIFICACAO)}>
            {ROTULO_CLASSIFICACAO[classificacao]}
          </span>
        )}
      </>
    );

  const botaoRegerar = podeRegerar && (
    <Button
      size="sm"
      variant="outline"
      className="h-8 border-orange-500/40 bg-transparent px-2.5 text-xs text-orange-200 hover:bg-orange-500/15 hover:text-orange-100"
      disabled={pedindo || bloqueado}
      title={
        bloqueado ? 'Ficha atualizada há pouco — disponível de novo em alguns minutos.' : undefined
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
  );

  return (
    <section
      className={cn('overflow-hidden rounded-xl border border-border bg-card', className)}
      aria-label="Ficha 360 do lead"
    >
      {/* ---------------- Cabecalho ---------------- */}
      {mostrarCabecalho ? (
        <div className="flex items-start gap-3 px-4 pb-3 pt-4">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-sm font-semibold text-blue-300"
          >
            {iniciais(lead.nome)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold leading-tight">{lead.nome}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {lead.telefone ? formatPhone(lead.telefone) : 'Sem telefone'}
            </p>
            {badges && <div className="mt-2 flex flex-wrap gap-1.5">{badges}</div>}
          </div>
        </div>
      ) : (
        // Sem cabecalho proprio a fileira de badges continua: a classificacao
        // derivada nao existe em nenhum outro lugar da tela. Sem badge nenhum o
        // bloco some inteiro, senao sobra um vao em branco no topo.
        badges && <div className="flex flex-wrap gap-1.5 px-4 pb-2 pt-4">{badges}</div>
      )}

      {/* ---------------- Dados duros ---------------- */}
      <dl className="px-4">
        <Linha rotulo="Responsável">{responsavel}</Linha>
        <Linha rotulo="Temperatura">
          {temperaturaRotulo !== '' && (
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                temperaturaClasse,
              )}
            >
              {temperaturaRotulo}
            </span>
          )}
        </Linha>
        <Linha rotulo="Valor estimado">
          {lead.valor_estimado !== null && Number.isFinite(lead.valor_estimado) && (
            <span className="text-emerald-400">{BRL.format(lead.valor_estimado)}</span>
          )}
        </Linha>
        <Linha rotulo="Último contato">
          {dias === null ? (
            <span className="font-normal text-muted-foreground">Sem registro</span>
          ) : (
            // Uma semana parado e o gatilho de "esfriando" no backend: a mesma
            // fronteira acende o ambar aqui.
            <span className={cn(dias >= DIAS_ALERTA && 'text-amber-400')}>
              {dias === 0 ? 'Hoje' : `Há ${dias} dia${dias === 1 ? '' : 's'}`}
            </span>
          )}
        </Linha>
        <Linha rotulo="Próximo contato">{proximaAcao}</Linha>
        <Linha rotulo="Tags">
          {tags.length > 0 && (
            <span className="flex flex-wrap justify-end gap-1">
              {tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </span>
          )}
        </Linha>
      </dl>

      {/* ---------------- Conteudo da IA ---------------- */}
      <div className="px-4 pb-4">
        {isLoading ? (
          <div className="pt-4">
            <EsqueletoFicha />
          </div>
        ) : isError ? (
          <p className="mt-4 text-xs text-muted-foreground">
            Não foi possível carregar a leitura da IA
            {statusDoErro(error) ? ` (erro ${statusDoErro(error)})` : ''}. Os dados do lead acima
            continuam válidos.
          </p>
        ) : !insight ? (
          <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-6 text-center">
            <Sparkles aria-hidden className="mx-auto h-5 w-5 text-muted-foreground/70" />
            <p className="mt-2 text-sm text-muted-foreground">
              A IA ainda não leu esta conversa. A ficha é montada sozinha conforme o cliente
              responde.
            </p>
            {podeRegerar && (
              <Button
                size="sm"
                variant="outline"
                className="mt-3 h-8 text-xs"
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
                  <Sparkles className="mr-1 h-3.5 w-3.5" />
                )}
                {pedindo ? 'Enviando...' : 'Gerar agora'}
              </Button>
            )}
          </div>
        ) : (
          <>
            {insight.resumo.trim() !== '' && (
              <>
                <Secao>Última conversa — resumo da IA</Secao>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {insight.resumo}
                </p>
              </>
            )}

            {insight.memoria.length > 0 && (
              <>
                <Secao>Memória do relacionamento</Secao>
                {/* Paragrafo corrido separado por " · " (nao lista de chips):
                    le como uma frase sobre a pessoa, que e o ponto. */}
                <p className="mt-1.5 break-words text-sm leading-relaxed">
                  {insight.memoria.map((fato, i) => (
                    <span key={`${i}-${fato.fato}`}>
                      {i > 0 && <span className="text-muted-foreground/50"> · </span>}
                      {fato.fato}
                      {fato.quando_dito.trim() !== '' && (
                        <span className="text-muted-foreground"> ({fato.quando_dito})</span>
                      )}
                    </span>
                  ))}
                </p>
              </>
            )}

            {compra && (
              <>
                <Secao>Última compra</Secao>
                <p className="mt-1.5 break-words text-sm leading-relaxed">
                  {compra.descricao}
                  {compra.valor !== null && (
                    <span className="font-semibold text-emerald-400">
                      {' · '}
                      {BRL.format(compra.valor)}
                    </span>
                  )}
                  {compra.quando !== '' && (
                    <span className="text-muted-foreground">
                      {' · '}
                      {compra.quando}
                    </span>
                  )}
                </p>
              </>
            )}

            {/* Nota e textos sao INDEPENDENTES: pode vir so o quadrado (o
                modelo pontuou sem justificar) ou so os textos (justificou sem
                pontuar). Cada metade aparece por conta propria. */}
            {temNota && (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Secao>Nota do atendimento</Secao>
                  {(pontoForte !== '' || pontoMelhoria !== '') && (
                    <div className="mt-1.5 space-y-1">
                      {pontoForte !== '' && (
                        <p className="break-words text-sm leading-relaxed">
                          <span className="font-medium text-foreground">Ponto forte: </span>
                          <span className="text-muted-foreground">{pontoForte}</span>
                        </p>
                      )}
                      {pontoMelhoria !== '' && (
                        <p className="break-words text-sm leading-relaxed">
                          <span className="font-medium text-foreground">Melhorar: </span>
                          <span className="text-muted-foreground">{pontoMelhoria}</span>
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {nota !== null && (
                  <div
                    className={cn(
                      'mt-4 flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border',
                      corDaNota(nota),
                    )}
                    title={`Nota ${nota} de 10`}
                  >
                    <span className="text-2xl font-bold leading-none">{nota}</span>
                    <span className="mt-0.5 text-[10px] font-medium opacity-70">/10</span>
                  </div>
                )}
              </div>
            )}

            {/* ---------------- Sugestao da IA ---------------- */}
            {msg !== '' ? (
              <div className="mt-4 rounded-xl border border-orange-500/40 bg-gradient-to-br from-orange-500/20 to-orange-600/10 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-orange-300/90">
                  Sugestão da IA
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium leading-relaxed text-orange-200">
                  {msg}
                </p>
                {(proximaAcao || insight.proxima_acao_motivo.trim() !== '') && (
                  <p className="mt-2 break-words text-xs leading-relaxed text-orange-300/80">
                    {proximaAcao ? `Melhor momento: ${proximaAcao}` : 'Sem janela definida'}
                    {insight.proxima_acao_motivo.trim() !== '' && ` — ${insight.proxima_acao_motivo}`}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {botaoRegerar}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 border-orange-500/40 bg-transparent px-2.5 text-xs text-orange-200 hover:bg-orange-500/15 hover:text-orange-100"
                    onClick={() => void copiar(msg)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    Copiar
                  </Button>
                  {onUsarMensagem && (
                    <Button
                      size="sm"
                      className="h-8 bg-orange-500 px-3 text-xs font-semibold text-white hover:bg-orange-600"
                      onClick={() => onUsarMensagem(msg)}
                    >
                      <Send className="mr-1 h-3.5 w-3.5" />
                      Usar
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              // Ficha sem `msg_sugerida` (o modelo devolveu vazio) tambem
              // precisa de um caminho para pedir outra geracao.
              podeRegerar && (
                <div className="mt-4 flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
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
                </div>
              )
            )}

            {atualizadaEm && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Ficha atualizada em {atualizadaEm}
                {insight.geracoes > 0 ? ` · ${insight.geracoes} geração(ões)` : ''}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
