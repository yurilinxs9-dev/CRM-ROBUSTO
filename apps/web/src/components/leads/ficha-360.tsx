'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  /**
   * Temperatura que a IA leu da conversa. `null` quando o modelo nao avaliou
   * ou quando o backend ainda nao tem as colunas (versao anterior a fase 4).
   */
  temperatura_sugerida: string | null;
  /** Por que a IA leu essa temperatura. `''` quando nao ha leitura. */
  temperatura_justificativa: string;
  /** Etapa que a IA acha que o lead ja merece. `null` = sem sugestao aberta. */
  etapa_sugerida_id: string | null;
  etapa_sugerida_motivo: string;
  /**
   * Nome da etapa sugerida, vindo da relacao `etapa_sugerida: { nome }` do GET.
   * `''` quando o backend nao inclui a relacao — o card cai para "a proxima
   * etapa" em vez de mostrar um id cru.
   */
  etapa_sugerida_nome: string;
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

/**
 * Campo de texto que so vale preenchido: string vazia (ou qualquer outra
 * coisa) vira `null`. Usado nos campos novos da fase 4, que simplesmente NAO
 * EXISTEM no corpo devolvido por um backend anterior.
 */
function textoOuNulo(valor: unknown): string | null {
  const limpo = texto(valor).trim();
  return limpo === '' ? null : limpo;
}

/**
 * Nome da etapa sugerida a partir da relacao `etapa_sugerida: { nome }`. Se o
 * GET nao incluir a relacao (ou vier `null`), devolve `''` — nunca o id.
 */
function lerEtapaSugeridaNome(valor: unknown): string {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return '';
  return texto((valor as Record<string, unknown>).nome).trim();
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
  const temperaturaJustificativa = texto(registro.temperatura_justificativa).trim();
  const etapaSugeridaId = textoOuNulo(registro.etapa_sugerida_id);
  // Linha existe mas o worker ainda nao escreveu nada de util: para o usuario
  // isso e o mesmo que "ainda nao gerado". Nota e compra entram na conta —
  // uma ficha que so avaliou o atendimento ainda tem o que mostrar. Idem para
  // a leitura de temperatura e a sugestao de etapa: cada uma sozinha ja e
  // conteudo na tela.
  const vazia =
    resumo.trim() === '' &&
    memoria.length === 0 &&
    msg.trim() === '' &&
    nota === null &&
    compra === null &&
    pontoForte.trim() === '' &&
    pontoMelhoria.trim() === '' &&
    temperaturaJustificativa === '' &&
    etapaSugeridaId === null;
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
    temperatura_sugerida: textoOuNulo(registro.temperatura_sugerida),
    temperatura_justificativa: temperaturaJustificativa,
    etapa_sugerida_id: etapaSugeridaId,
    etapa_sugerida_motivo: texto(registro.etapa_sugerida_motivo).trim(),
    etapa_sugerida_nome: lerEtapaSugeridaNome(registro.etapa_sugerida),
    geracoes: typeof registro.geracoes === 'number' ? registro.geracoes : 0,
    updated_at: texto(registro.updated_at),
  };
}

/**
 * `GET /api/leads/:id/lembretes` (Fase 3). Backend antigo nao tem a rota: o
 * bloco inteiro some em silencio, sem mensagem de erro numa ficha que continua
 * util. `origem`/`status` sao String livre no banco — tipa como string e
 * compara com os valores conhecidos, em vez de fingir um enum que o servidor
 * nao garante.
 */
export interface LeadLembrete {
  id: string;
  motivo: string;
  dito_em: string;
  avisar_em: string;
  /** 'ia' | 'manual'. */
  origem: string;
  /** 'pendente' | 'feito' | 'descartado'. */
  status: string;
}

function lerLembretes(corpo: unknown): LeadLembrete[] {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return [];
  const lista = (corpo as Record<string, unknown>).lembretes;
  if (!Array.isArray(lista)) return [];
  const saida: LeadLembrete[] = [];
  for (const bruto of lista) {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) continue;
    const registro = bruto as Record<string, unknown>;
    const id = texto(registro.id);
    if (id === '') continue;
    saida.push({
      id,
      motivo: texto(registro.motivo),
      dito_em: texto(registro.dito_em),
      avisar_em: texto(registro.avisar_em),
      origem: texto(registro.origem),
      status: texto(registro.status),
    });
  }
  return saida;
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

/**
 * Rotulos da temperatura DENTRO DE UMA FRASE. Nao reaproveita `TEMP_LABELS` do
 * kanban de proposito: la `MUITO_QUENTE` e "Fogo", que funciona como badge mas
 * nao como texto corrido ("sugere temperatura Fogo").
 */
const ROTULO_TEMPERATURA: Record<string, string> = {
  FRIO: 'Frio',
  MORNO: 'Morno',
  QUENTE: 'Quente',
  MUITO_QUENTE: 'Muito quente',
};

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
 *
 * O corte de 2 dias do "Promissor" casa com `RADAR_PROMISSOR_DIAS` do backend —
 * badge e fila mostram a mesma populacao. Decisao registrada 2026-08-25: a
 * coerencia com o Radar vence a letra da spec.
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

/**
 * Cor por classificacao, nao uma cor so: a mesma pilula laranja em "Chamar
 * hoje" e em "Esfriando" faria a badge decorar em vez de informar. Verde =
 * agir agora, laranja = oportunidade viva, azul apagado = perdendo calor.
 */
const PILULA_CLASSIFICACAO: Record<Exclude<ClassificacaoLead, null>, string> = {
  chamar_hoje: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
  promissor: 'border-orange-500/50 bg-orange-500/10 text-orange-300',
  esfriando: 'border-sky-500/40 bg-sky-500/10 text-sky-300/80',
};

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
function Linha({
  rotulo,
  title,
  children,
}: {
  rotulo: string;
  /** Detalhe que nao cabe na linha (data completa, motivo inteiro). */
  title?: string;
  children: ReactNode;
}) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/5 py-[10px]">
      <dt className="shrink-0 text-sm text-muted-foreground">{rotulo}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-semibold" title={title}>
        {children}
      </dd>
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
// Lembretes do lead
// ---------------------------------------------------------------------------

/** Data sem hora: lembrete e compromisso de DIA, nao de horario. */
function formatarDia(iso: string): string | null {
  if (iso.trim() === '') return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Bloco de lembretes da ficha: o que o cliente pediu para ser lembrado, mais um
 * formulario minimo para o vendedor marcar um compromisso na mao.
 *
 * O componente inteiro SOME quando a rota nao existe (backend anterior a Fase
 * 3) ou quando a leitura falha — uma ficha sem este bloco continua completa, e
 * um erro aqui nao vale um aviso vermelho no meio dela.
 *
 * `motivo` de lembrete 'ia' e texto gerado a partir do que o CLIENTE escreveu:
 * so pode ser renderizado como texto React puro.
 */
function BlocoLembretes({ leadId, enabled }: { leadId: string; enabled: boolean }) {
  const queryClient = useQueryClient();
  const [motivo, setMotivo] = useState('');
  const [quando, setQuando] = useState('');

  const { data: lembretes, isError } = useQuery<LeadLembrete[]>({
    queryKey: ['lead-lembretes', leadId],
    queryFn: async () => lerLembretes((await api.get(`/api/leads/${leadId}/lembretes`)).data),
    enabled: enabled && !!leadId,
    retry: false,
  });

  // O drawer reaproveita a ficha entre leads sem remontar: sem isto o rascunho
  // digitado num lead apareceria no formulario do proximo.
  useEffect(() => {
    setMotivo('');
    setQuando('');
  }, [leadId]);

  /** A lista e o radar mudam juntos: um lembrete concluido some das duas telas. */
  const invalidar = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead-lembretes', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['radar'] });
  };

  const criar = useMutation({
    mutationFn: async (dados: { motivo: string; avisar_em: string }) => {
      await api.post(`/api/leads/${leadId}/lembretes`, dados);
    },
    onSuccess: () => {
      setMotivo('');
      setQuando('');
      toast.success('Lembrete criado');
      invalidar();
    },
    onError: (err: unknown) => {
      // Data no passado volta 400 com a frase do backend — mostra ela, que ja
      // explica o problema melhor do que qualquer texto generico daqui.
      toast.error(mensagemDoErro(err) ?? 'Não foi possível criar o lembrete.');
    },
  });

  const agir = useMutation({
    mutationFn: async (pedido: { id: string; acao: 'concluir' | 'descartar' }) => {
      await api.post(`/api/lembretes/${pedido.id}/${pedido.acao}`);
    },
    onSuccess: (_dados, pedido) => {
      toast.success(pedido.acao === 'concluir' ? 'Lembrete concluído' : 'Lembrete descartado');
      invalidar();
    },
    onError: (err: unknown) => {
      toast.error(mensagemDoErro(err) ?? 'Não foi possível atualizar o lembrete.');
    },
  });

  // Rota inexistente/erro: o bloco some. `undefined` = ainda carregando.
  if (isError || lembretes === undefined) return null;

  const pendentes = lembretes.filter((l) => l.status === 'pendente');
  const criando = criar.isPending;
  const podeCriar = motivo.trim() !== '' && quando !== '' && !criando;

  return (
    <>
      <Secao>Lembretes</Secao>

      {pendentes.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted-foreground">
          Nenhum lembrete pendente. Marque abaixo quando voltar a falar.
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {pendentes.map((lembrete) => {
            const dia = formatarDia(lembrete.avisar_em);
            // Trava por lembrete: resolver um nao pode desabilitar os outros.
            const ocupado =
              agir.isPending && agir.variables?.id === lembrete.id;
            return (
              <li
                key={lembrete.id}
                className="flex items-start gap-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.07] px-2.5 py-2"
              >
                <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-violet-200">
                    {dia ?? 'Sem data'}
                    {lembrete.origem === 'manual' && (
                      <span className="ml-1.5 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        manual
                      </span>
                    )}
                  </p>
                  {lembrete.motivo.trim() !== '' && (
                    <p className="mt-0.5 break-words text-sm leading-relaxed">{lembrete.motivo}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <button
                    type="button"
                    aria-label="Concluir lembrete"
                    title="Concluir"
                    disabled={ocupado}
                    onClick={() => agir.mutate({ id: lembrete.id, acao: 'concluir' })}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-emerald-500/15 hover:text-emerald-300 disabled:pointer-events-none disabled:opacity-50"
                  >
                    {ocupado && agir.variables?.acao === 'concluir' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Descartar lembrete"
                    title="Descartar"
                    disabled={ocupado}
                    onClick={() => agir.mutate({ id: lembrete.id, acao: 'descartar' })}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-300 disabled:pointer-events-none disabled:opacity-50"
                  >
                    {ocupado && agir.variables?.acao === 'descartar' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* `<form>` de verdade: Enter no campo de motivo cria o lembrete. */}
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!podeCriar) return;
          criar.mutate({ motivo: motivo.trim(), avisar_em: quando });
        }}
      >
        <Input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          maxLength={200}
          placeholder="Voltar a falar sobre..."
          aria-label="Motivo do lembrete"
          className="h-8 min-w-[10rem] flex-1 text-sm"
        />
        <input
          type="date"
          value={quando}
          onChange={(e) => setQuando(e.target.value)}
          aria-label="Data do lembrete"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={!podeCriar}>
          {criando ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1 h-3.5 w-3.5" />
          )}
          {criando ? 'Criando...' : 'Criar lembrete'}
        </Button>
      </form>
    </>
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
  /**
   * `true` onde a ficha divide a rolagem com outra coisa (o drawer de 448px, em
   * cima de um formulario inteiro): ganha uma barra de titulo que recolhe o
   * corpo. Aberta por padrao. No Radar fica `false` — a expansao do card ja e o
   * colapso, e uma segunda seta dentro dela seria um botao de fechar duplicado.
   */
  colapsavel?: boolean;
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
  colapsavel = false,
  className,
}: Ficha360Props) {
  const queryClient = useQueryClient();
  const papel = useAuthStore((s) => s.user?.role);
  const podeRegerar = !!papel && PAPEIS_QUE_REGERAM.includes(papel);
  /** So tem efeito com `colapsavel`. A query segue viva de qualquer jeito. */
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

  // O drawer e reaproveitado entre leads (o componente nao remonta). Sem isto,
  // recolher a ficha de um lead deixaria a do PROXIMO recolhida tambem.
  useEffect(() => {
    setAberto(true);
  }, [leadId]);

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

  /**
   * Aceitar a sugestao MOVE o lead de etapa. As invalidacoes sao as mesmas que
   * o kanban faz apos um arrastar (`['leads']` + `['lead-activities', id]`) e
   * as que o drawer faz apos qualquer mutacao da ficha (`['lead', id]` e
   * `['chat','leads']`) — a ficha vive nos TRES lugares e nao sabe em qual
   * esta, entao invalida o conjunto. O radar entra pelo prefixo (a chave real
   * carrega o funil) e e o caso mais visivel: `staleTime` de 60s deixaria a
   * pilula de etapa mostrando a etapa velha logo depois do clique em "Mover".
   */
  const invalidarAposMover = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ['lead-insight', id] });
    void queryClient.invalidateQueries({ queryKey: ['lead', id] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
    void queryClient.invalidateQueries({ queryKey: ['lead-activities', id] });
    void queryClient.invalidateQueries({ queryKey: ['radar'] });
  };

  /**
   * As duas mutacoes recebem o `leadId` como VARIAVEL (em vez de le-lo do
   * closure) por um motivo so: o drawer reaproveita este componente entre leads
   * sem remontar, entao o estado da mutacao sobrevive a troca. Com a variavel
   * em maos da pra saber DE QUAL lead foi aquele sucesso — e a trava de duplo
   * clique nao vaza para o proximo lead.
   */
  const aceitarEtapa = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/leads/${id}/insight/etapa-sugerida/aceitar`);
    },
    onSuccess: (_dados, id) => {
      toast.success('Lead movido');
      invalidarAposMover(id);
    },
    onError: (err: unknown) => {
      if (statusDoErro(err) === 403) {
        toast.error('Você não tem permissão para mover este lead.');
        return;
      }
      toast.error(mensagemDoErro(err) ?? 'Não foi possível mover o lead.');
    },
  });

  const recusarEtapa = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/leads/${id}/insight/etapa-sugerida/recusar`);
    },
    onSuccess: (_dados, id) => {
      toast.success('Sugestão dispensada');
      // So a ficha muda: o lead continua exatamente onde estava.
      void queryClient.invalidateQueries({ queryKey: ['lead-insight', id] });
    },
    onError: (err: unknown) => {
      toast.error(mensagemDoErro(err) ?? 'Não foi possível dispensar a sugestão.');
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
  const motivoProximaAcao = insight?.proxima_acao_motivo.trim() ?? '';
  const ultimaInteracaoCompleta = formatarData(lead.ultima_interacao);
  const atualizadaEm = formatarData(insight?.updated_at);

  const temperaturaRotulo = buscarTexto(TEMP_LABELS, lead.temperatura) ?? lead.temperatura.trim();
  const temperaturaClasse =
    buscarTexto(TEMP_BADGE, lead.temperatura) ?? buscarTexto(TEMP_BADGE, '_DEFAULT') ?? '';

  /**
   * Uma frase so sobre a temperatura, em portugues de gente. Tres casos:
   * - o lead JA esta na temperatura que a IA leu → ela mesma ajustou (toggle
   *   ligado): "ajustada automaticamente";
   * - esta em outra → a leitura ficou como sugestao (toggle desligado), e quem
   *   aplica e o vendedor editando o lead — caminho que ja existe;
   * - nao da pra provar a diferenca (o lead nao tem temperatura na tela, ou a
   *   ficha nao registrou qual temperatura sugeriu) → so a leitura, sem
   *   afirmar que houve ajuste nem que ha sugestao pendente.
   */
  const textoTemperaturaIA = useMemo(() => {
    const justificativa = insight?.temperatura_justificativa.trim() ?? '';
    if (justificativa === '') return '';
    const atual = lead.temperatura.trim();
    const sugerida = insight?.temperatura_sugerida?.trim() ?? '';
    if (atual === '' || sugerida === '') return `Temperatura: ${justificativa}`;
    if (atual === sugerida) return `Temperatura ajustada automaticamente: ${justificativa}`;
    const rotulo = buscarTexto(ROTULO_TEMPERATURA, sugerida) ?? sugerida;
    return `A ficha sugere temperatura ${rotulo} — ${justificativa}`;
  }, [insight?.temperatura_justificativa, insight?.temperatura_sugerida, lead.temperatura]);

  const etapaSugeridaId = insight?.etapa_sugerida_id ?? null;
  const etapaSugeridaNome = insight?.etapa_sugerida_nome ?? '';
  const etapaSugeridaMotivo = insight?.etapa_sugerida_motivo ?? '';
  /** Sem a relacao no GET nao ha nome — a frase e o botao falam da "etapa". */
  const alvoEtapa = etapaSugeridaNome !== '' ? `"${etapaSugeridaNome}"` : 'a próxima etapa';
  const rotuloMover = etapaSugeridaNome !== '' ? `Mover para ${etapaSugeridaNome}` : 'Mover lead';
  const movendo = aceitarEtapa.isPending;
  const recusando = recusarEtapa.isPending;
  /**
   * Os dois botoes travam juntos, e continuam travados DEPOIS do sucesso: entre
   * o fim da mutacao e o refetch que apaga o card existe uma janela de alguns
   * centenas de ms em que o card ainda esta na tela — sem isto, um segundo
   * clique dispararia um POST para uma sugestao que ja nao existe.
   */
  const decidido =
    movendo ||
    recusando ||
    (aceitarEtapa.isSuccess && aceitarEtapa.variables === leadId) ||
    (recusarEtapa.isSuccess && recusarEtapa.variables === leadId);

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
          <span className={cn(PILULA, PILULA_CLASSIFICACAO[classificacao])}>
            {ROTULO_CLASSIFICACAO[classificacao]}
          </span>
        )}
      </>
    );

  /**
   * O MESMO elemento entra em dois ramos EXCLUSIVOS do render abaixo (ficha
   * gerada e ficha ainda nao gerada): lembrete manual nao depende da IA ter
   * lido a conversa, entao o bloco precisa existir nos dois casos — e so um
   * deles renderiza por vez.
   */
  const blocoLembretes = <BlocoLembretes leadId={leadId} enabled={enabled} />;

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
      {/* ---------------- Barra de colapso ---------------- */}
      {colapsavel && (
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          aria-expanded={aberto}
          className={cn(
            'flex w-full items-center gap-1.5 px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground',
            aberto && 'border-b border-white/5',
          )}
        >
          {aberto ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <Brain className="h-3.5 w-3.5" />
          Ficha 360
          {/* Recolhida, a barra e a unica coisa visivel: o sinal de urgencia
              nao pode sumir junto com o corpo. */}
          {!aberto && classificacao && (
            <span
              className={cn(
                'ml-auto rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                PILULA_CLASSIFICACAO[classificacao],
              )}
            >
              {ROTULO_CLASSIFICACAO[classificacao]}
            </span>
          )}
        </button>
      )}

      {colapsavel && !aberto ? null : (
        <>
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
            badges && (
              <div className={cn('flex flex-wrap gap-1.5 px-4 pb-2', colapsavel ? 'pt-3' : 'pt-4')}>
                {badges}
              </div>
            )
          )}

          {/* ---------------- Dados duros ---------------- */}
          <dl className="px-4">
            <Linha rotulo="Responsável">{responsavel}</Linha>
            <Linha rotulo="Temperatura">
              {(temperaturaRotulo !== '' || textoTemperaturaIA !== '') && (
                <>
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
                  {/* Texto da IA: renderizado como texto React puro, nunca como
                      HTML — sai de uma conversa escrita pelo cliente. */}
                  {textoTemperaturaIA !== '' && (
                    <span className="mt-1 block break-words text-xs font-normal leading-relaxed text-muted-foreground">
                      {textoTemperaturaIA}
                    </span>
                  )}
                </>
              )}
            </Linha>
            <Linha rotulo="Valor estimado">
              {lead.valor_estimado !== null && Number.isFinite(lead.valor_estimado) && (
                <span className="text-emerald-400">{BRL.format(lead.valor_estimado)}</span>
              )}
            </Linha>
            <Linha rotulo="Último contato" title={ultimaInteracaoCompleta ?? undefined}>
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
            <Linha
              rotulo="Próximo contato"
              title={motivoProximaAcao !== '' ? motivoProximaAcao : undefined}
            >
              {/* O motivo so aparecia dentro do bloco da sugestao — ficha sem
                  `msg_sugerida` perdia o "por que". E o modelo pode devolver
                  motivo SEM data: entao a linha existe com "—" no lugar da
                  data, senao o motivo sumia de novo. */}
              {(proximaAcao || motivoProximaAcao !== '') && (
                <>
                  {proximaAcao ?? <span className="font-normal text-muted-foreground">—</span>}
                  {motivoProximaAcao !== '' && (
                    <span className="mt-0.5 line-clamp-2 block text-xs font-normal text-muted-foreground">
                      {motivoProximaAcao}
                    </span>
                  )}
                </>
              )}
            </Linha>
            <Linha rotulo="Tags">
              {tags.length > 0 && (
                <span className="flex flex-wrap justify-end gap-1">
                  {/* Tag repetida (relacao + Json legado) nao pode quebrar a key. */}
                  {tags.map((t, i) => (
                    <span
                      key={`${i}-${t}`}
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
              <>
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

                {/* Lembrete manual nao depende da IA: mesmo sem ficha gerada o
                    vendedor pode marcar quando voltar a falar. */}
                {blocoLembretes}
              </>
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

                {blocoLembretes}

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

                {/* ---------------- Sugestao de etapa ----------------
                    Mesmo desenho do bloco laranja da mensagem sugerida, em
                    azul: la e "o que dizer", aqui e "onde o lead ja esta". As
                    duas cores separam sugestao de texto de sugestao de acao. */}
                {etapaSugeridaId !== null && (
                  <div className="mt-4 rounded-xl border border-blue-500/40 bg-gradient-to-br from-blue-500/20 to-blue-600/10 p-4">
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-blue-300/90">
                      Mover para...
                    </p>
                    <p className="mt-2 break-words text-sm font-medium leading-relaxed text-blue-200">
                      {`Parece pronto para ${alvoEtapa}`}
                      {etapaSugeridaMotivo !== '' && ` — ${etapaSugeridaMotivo}`}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2.5 text-xs text-blue-200/90 hover:bg-blue-500/15 hover:text-blue-100"
                        disabled={decidido}
                        onClick={() => recusarEtapa.mutate(leadId)}
                      >
                        {recusando && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                        {recusando ? 'Dispensando...' : 'Agora não'}
                      </Button>
                      <Button
                        size="sm"
                        className="h-8 bg-blue-500 px-3 text-xs font-semibold text-white hover:bg-blue-600"
                        disabled={decidido}
                        onClick={() => aceitarEtapa.mutate(leadId)}
                      >
                        {movendo ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArrowRight className="mr-1 h-3.5 w-3.5" />
                        )}
                        {movendo ? 'Movendo...' : rotuloMover}
                      </Button>
                    </div>
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
                    {(proximaAcao || motivoProximaAcao !== '') && (
                      <p className="mt-2 break-words text-xs leading-relaxed text-orange-300/80">
                        {proximaAcao ? `Melhor momento: ${proximaAcao}` : 'Sem janela definida'}
                        {motivoProximaAcao !== '' && ` — ${motivoProximaAcao}`}
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
        </>
      )}
    </section>
  );
}
