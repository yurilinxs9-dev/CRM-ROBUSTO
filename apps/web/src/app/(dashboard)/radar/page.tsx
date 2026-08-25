'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  MessageSquare,
  PhoneCall,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TEMP_BADGE, TEMP_LABELS, formatPhone } from '@/components/kanban/lead-card';
import { Ficha360 } from '@/components/leads/ficha-360';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

// ---------------------------------------------------------------------------
// Contrato da API (Task 5)
// ---------------------------------------------------------------------------

/**
 * `GET /api/insights/radar` devolve as tres filas do dia. As datas saem do Nest
 * ja serializadas em ISO (ou `null`), por isso aqui elas sao `string | null`.
 */
export interface RadarItem {
  lead_id: string;
  nome: string;
  telefone: string;
  etapa: string;
  temperatura: string;
  ultima_interacao: string | null;
  motivo: string;
  msg_sugerida: string;
  proxima_acao_at: string | null;
  /** Nome de quem responde pelo lead. `null` = lead sem dono (pool). */
  responsavel: string | null;
  /** Nomes das tags, achatados pelo backend (relação + Json legado). */
  tags: string[];
}

export interface RadarResposta {
  chamar_hoje: RadarItem[];
  promissores: RadarItem[];
  esfriando: RadarItem[];
}

const VAZIO: RadarResposta = { chamar_hoje: [], promissores: [], esfriando: [] };

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** Backend antigo nao manda `tags`; Json cru pode ter numero/null no meio. */
function lerTags(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

/**
 * Le uma secao tolerando corpo estranho (backend antigo, secao ausente). Uma
 * fila quebrada nao pode derrubar a pagina inteira — o vendedor perderia as
 * outras duas.
 */
function lerItens(valor: unknown): RadarItem[] {
  if (!Array.isArray(valor)) return [];
  const saida: RadarItem[] = [];
  for (const bruto of valor) {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) continue;
    const registro = bruto as Record<string, unknown>;
    const leadId = texto(registro.lead_id);
    if (leadId === '') continue;
    saida.push({
      lead_id: leadId,
      nome: texto(registro.nome) || 'Sem nome',
      telefone: texto(registro.telefone),
      etapa: texto(registro.etapa),
      temperatura: texto(registro.temperatura),
      ultima_interacao: textoOuNulo(registro.ultima_interacao),
      motivo: texto(registro.motivo),
      msg_sugerida: texto(registro.msg_sugerida),
      proxima_acao_at: textoOuNulo(registro.proxima_acao_at),
      responsavel: textoOuNulo(registro.responsavel),
      tags: lerTags(registro.tags),
    });
  }
  return saida;
}

function normalizar(corpo: unknown): RadarResposta {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return VAZIO;
  const registro = corpo as Record<string, unknown>;
  return {
    chamar_hoje: lerItens(registro.chamar_hoje),
    promissores: lerItens(registro.promissores),
    esfriando: lerItens(registro.esfriando),
  };
}

// ---------------------------------------------------------------------------
// Formatacao
// ---------------------------------------------------------------------------

const DIA_MS = 24 * 60 * 60 * 1000;

/** "há N dias sem contato" — o dado que decide se vale a ligação. */
function rotuloSemContato(iso: string | null): string {
  if (!iso) return 'Sem contato registrado';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return 'Sem contato registrado';
  const dias = Math.max(0, Math.floor((Date.now() - data.getTime()) / DIA_MS));
  if (dias === 0) return 'Falaram hoje';
  return `Há ${dias} dia${dias === 1 ? '' : 's'} sem contato`;
}

function formatarData(iso: string | null): string | null {
  if (!iso) return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * `temperatura` vem do backend como string solta — pode ser um valor novo do
 * enum, ou uma chave do prototipo (`constructor`). Checa o TIPO do resultado em
 * vez de confiar no indice: chave herdada devolve funcao, e funcao nao renderiza
 * (e, na classe, viraria `class=[object Function]`).
 */
function buscarTexto(mapa: Record<string, string>, chave: string): string | null {
  const valor: unknown = mapa[chave];
  return typeof valor === 'string' ? valor : null;
}

function rotuloTemperatura(valor: string): string {
  return buscarTexto(TEMP_LABELS, valor) ?? valor;
}

function classeTemperatura(valor: string): string {
  return buscarTexto(TEMP_BADGE, valor) ?? buscarTexto(TEMP_BADGE, '_DEFAULT') ?? '';
}

// ---------------------------------------------------------------------------
// Secoes
// ---------------------------------------------------------------------------

interface Secao {
  chave: keyof RadarResposta;
  titulo: string;
  descricao: string;
  /** Texto quando a fila esta vazia. So a primeira merece comemoracao. */
  vazio: string;
}

const SECOES: Secao[] = [
  {
    chave: 'chamar_hoje',
    titulo: 'Chamar hoje',
    descricao: 'A ficha marcou uma próxima ação que já venceu.',
    vazio: 'Ninguém por aqui 🎉',
  },
  {
    chave: 'promissores',
    titulo: 'Promissores',
    descricao: 'Lead quente que parou de conversar.',
    vazio: '—',
  },
  {
    chave: 'esfriando',
    titulo: 'Esfriando',
    descricao: 'Lead ativo parado há mais de uma semana.',
    vazio: '—',
  },
];

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  item: RadarItem;
  /** Um por vez: a pagina guarda o id expandido. */
  expandido: boolean;
  onAlternar: () => void;
  onCopiar: (valor: string) => void;
  onAbrir: (leadId: string) => void;
}

/**
 * `motivo` e `msg_sugerida` sao texto de LLM gerado a partir do que o CLIENTE
 * escreveu no WhatsApp. Renderiza SO como texto React — nada de
 * `dangerouslySetInnerHTML` nem markdown, senao o cliente injeta HTML na tela
 * do vendedor.
 */
function RadarCard({ item, expandido, onAlternar, onCopiar, onAbrir }: CardProps) {
  const acaoEm = formatarData(item.proxima_acao_at);
  const msg = item.msg_sugerida.trim();
  const temperatura = rotuloTemperatura(item.temperatura).trim();

  // Expandido a Ficha 360 TOMA o lugar do resumo do card: ela ja tem cabecalho,
  // etapa, temperatura e a mensagem sugerida. Manter os dois seria a mesma
  // informacao duas vezes, uma em cima da outra.
  if (expandido) {
    return (
      <article className="flex animate-in flex-col gap-2 fade-in-0 slide-in-from-top-1 duration-200">
        <Ficha360
          leadId={item.lead_id}
          lead={{
            nome: item.nome,
            telefone: item.telefone || null,
            etapa: item.etapa,
            temperatura: item.temperatura,
            // O radar nao carrega valor estimado — a linha some sozinha.
            valor_estimado: null,
            ultima_interacao: item.ultima_interacao,
            responsavel: item.responsavel,
            tags: item.tags,
            proxima_acao_at: item.proxima_acao_at,
          }}
        />
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={() => onAbrir(item.lead_id)}>
            <MessageSquare className="mr-1.5 h-4 w-4" />
            Abrir conversa
          </Button>
          <Button size="sm" variant="ghost" onClick={onAlternar} aria-expanded>
            <ChevronUp className="mr-1.5 h-4 w-4" />
            Fechar ficha
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/chat/${item.lead_id}`}
            className="block truncate text-sm font-medium hover:underline"
          >
            {item.nome}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {item.telefone ? formatPhone(item.telefone) : 'Sem telefone'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {item.etapa && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {item.etapa}
            </span>
          )}
          {/* Lead sem temperatura nao ganha pilula vazia. */}
          {temperatura && (
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                classeTemperatura(item.temperatura),
              )}
            >
              {temperatura}
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {rotuloSemContato(item.ultima_interacao)}
        {acaoEm ? ` · ação marcada para ${acaoEm}` : ''}
        {item.responsavel ? ` · ${item.responsavel}` : ''}
      </p>

      {/* Tags do lead: contexto que decide a abordagem antes de abrir a ficha. */}
      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          {item.tags.length > 4 && (
            <span className="px-1 py-0.5 text-[11px] text-muted-foreground">
              +{item.tags.length - 4}
            </span>
          )}
        </div>
      )}

      {item.motivo && <p className="text-sm">{item.motivo}</p>}

      {msg && (
        <div className="rounded-lg border border-border bg-muted/30 p-2.5">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Mensagem sugerida
          </p>
          {/* Truncada na tela; o botão copia o texto inteiro. */}
          <p className="line-clamp-2 text-sm" title={msg}>
            {msg}
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1.5 h-7 px-2 text-xs"
            onClick={() => onCopiar(msg)}
          >
            <Copy className="mr-1 h-3.5 w-3.5" />
            Copiar
          </Button>
        </div>
      )}

      <div className="mt-auto flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={() => onAbrir(item.lead_id)}>
          <MessageSquare className="mr-1.5 h-4 w-4" />
          Abrir conversa
        </Button>
        {/* A ficha so busca o insight depois deste clique (`enabled`): abrir o
            radar com 90 cards nao dispara 90 requisicoes. */}
        <Button size="sm" variant="ghost" onClick={onAlternar} aria-expanded={false}>
          <ChevronDown className="mr-1.5 h-4 w-4" />
          Ver ficha completa
        </Button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Pagina
// ---------------------------------------------------------------------------

export default function RadarPage() {
  const router = useRouter();
  /** Um card expandido por vez — `null` = todos recolhidos. */
  const [expandidoId, setExpandidoId] = useState<string | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery<RadarResposta>({
    queryKey: ['radar'],
    queryFn: async () => normalizar((await api.get('/api/insights/radar')).data),
    // A fila e montada por cron; recarregar a cada foco de aba nao muda nada.
    staleTime: 60_000,
  });

  const radar = data ?? VAZIO;
  const total = useMemo(
    () => radar.chamar_hoje.length + radar.promissores.length + radar.esfriando.length,
    [radar],
  );

  const copiar = (valor: string) => {
    navigator.clipboard.writeText(valor).then(
      () => toast.success('Mensagem copiada'),
      () => toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.'),
    );
  };

  /**
   * `invalidateQueries` NAO serve aqui: no react-query v5 a promise dela resolve
   * mesmo quando o refetch falha (o erro fica no estado da query, nao rejeita) —
   * com o backend fora do ar a tela dizia "Radar atualizado". `refetch` devolve
   * o resultado, entao da pra falar a verdade.
   */
  const atualizar = () => {
    void refetch().then((resultado) => {
      if (resultado.isError) {
        toast.error('Não foi possível atualizar o radar.');
        return;
      }
      toast.success('Radar atualizado');
    });
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Radar"
        subtitle="A fila do dia: quem chamar, quem está promissor e quem está esfriando"
        actions={
          <Button variant="outline" size="sm" disabled={isFetching} onClick={atualizar}>
            <RefreshCw className={cn('mr-1.5 h-4 w-4', isFetching && 'animate-spin')} />
            Atualizar
          </Button>
        }
      />

      {/* KPI: o número que decide o começo do dia. */}
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <PhoneCall className="h-5 w-5" />
        </span>
        <div>
          {/* Em erro NAO cai pro zero: "0 para chamar hoje" em cima do bloco de
              erro e a tela mentindo que o dia esta limpo. */}
          <p className="text-2xl font-semibold leading-none">
            {isLoading || isError ? '—' : radar.chamar_hoje.length}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            para chamar hoje
            {!isLoading && !isError && total > 0 ? ` · ${total} no radar` : ''}
          </p>
        </div>
      </div>

      {isError ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">
            Não foi possível carregar o radar. Tente atualizar em alguns instantes.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={atualizar}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Tentar de novo
          </Button>
        </div>
      ) : (
        SECOES.map((secao) => {
          const itens = radar[secao.chave];
          return (
            <section key={secao.chave} className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold tracking-tight">
                  {secao.titulo}
                  {!isLoading && itens.length > 0 && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      ({itens.length})
                    </span>
                  )}
                </h3>
                <p className="text-xs text-muted-foreground">{secao.descricao}</p>
              </div>

              {isLoading ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-44 w-full rounded-xl" />
                  ))}
                </div>
              ) : itens.length === 0 ? (
                <p className="text-sm text-muted-foreground">{secao.vazio}</p>
              ) : (
                <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {itens.map((item) => (
                    <RadarCard
                      key={item.lead_id}
                      item={item}
                      expandido={expandidoId === item.lead_id}
                      onAlternar={() =>
                        setExpandidoId((atual) => (atual === item.lead_id ? null : item.lead_id))
                      }
                      onCopiar={copiar}
                      onAbrir={(leadId) => router.push(`/chat/${leadId}`)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
