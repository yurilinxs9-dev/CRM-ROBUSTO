'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  HelpCircle,
  Clock,
  MessageSquare,
  RefreshCw,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TEMP_BADGE, TEMP_LABELS, formatPhone } from '@/components/kanban/lead-card';
import { Ficha360 } from '@/components/leads/ficha-360';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

// ---------------------------------------------------------------------------
// Contrato da API
// ---------------------------------------------------------------------------

/**
 * `GET /api/insights/radar?pipeline_id=<uuid opcional>` devolve as quatro filas
 * do dia mais o `resumo` que alimenta o cabeçalho. As datas saem do Nest já
 * serializadas em ISO (ou `null`), por isso aqui elas sao `string | null`.
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
  /** Quando o cliente mandou a mensagem que ainda nao foi respondida. */
  esperando_desde: string | null;
}

export interface RadarResumo {
  esperando: number;
  chamar_hoje: number;
  valor_chamar_hoje: number;
  lembrete_destaque: { nome: string; motivo: string } | null;
}

export interface RadarResposta {
  resumo: RadarResumo;
  esperando_voce: RadarItem[];
  chamar_hoje: RadarItem[];
  promissores: RadarItem[];
  esfriando: RadarItem[];
}

/** Chaves que guardam filas — o `resumo` fica de fora de proposito. */
type ChaveFila = 'esperando_voce' | 'chamar_hoje' | 'promissores' | 'esfriando';

const RESUMO_ZERADO: RadarResumo = {
  esperando: 0,
  chamar_hoje: 0,
  valor_chamar_hoje: 0,
  lembrete_destaque: null,
};

const VAZIO: RadarResposta = {
  resumo: RESUMO_ZERADO,
  esperando_voce: [],
  chamar_hoje: [],
  promissores: [],
  esfriando: [],
};

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** `NaN`/`Infinity` viram 0: numero quebrado no cabecalho e pior que zero. */
function numero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/** Backend antigo nao manda `tags`; Json cru pode ter numero/null no meio. */
function lerTags(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

/**
 * Le uma secao tolerando corpo estranho (backend antigo, secao ausente). Uma
 * fila quebrada nao pode derrubar a pagina inteira — o vendedor perderia as
 * outras tres.
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
      esperando_desde: textoOuNulo(registro.esperando_desde),
    });
  }
  return saida;
}

function lerDestaque(valor: unknown): { nome: string; motivo: string } | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
  const registro = valor as Record<string, unknown>;
  const nome = texto(registro.nome).trim();
  if (nome === '') return null;
  return { nome, motivo: texto(registro.motivo).trim() };
}

/**
 * Durante a janela de deploy o backend antigo responde sem `resumo`. Em vez de
 * zerar o cabecalho (que diria "tudo em dia" com a fila cheia na tela), conta
 * as proprias listas — o `resumo` do servidor so e usado quando existe.
 */
function lerResumo(valor: unknown, filas: Record<ChaveFila, RadarItem[]>): RadarResumo {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return {
      esperando: filas.esperando_voce.length,
      chamar_hoje: filas.chamar_hoje.length,
      valor_chamar_hoje: 0,
      lembrete_destaque: null,
    };
  }
  const registro = valor as Record<string, unknown>;
  return {
    esperando: numero(registro.esperando),
    chamar_hoje: numero(registro.chamar_hoje),
    valor_chamar_hoje: numero(registro.valor_chamar_hoje),
    lembrete_destaque: lerDestaque(registro.lembrete_destaque),
  };
}

function normalizar(corpo: unknown): RadarResposta {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return VAZIO;
  const registro = corpo as Record<string, unknown>;
  const filas: Record<ChaveFila, RadarItem[]> = {
    esperando_voce: lerItens(registro.esperando_voce),
    chamar_hoje: lerItens(registro.chamar_hoje),
    promissores: lerItens(registro.promissores),
    esfriando: lerItens(registro.esfriando),
  };
  return { ...filas, resumo: lerResumo(registro.resumo, filas) };
}

/** So o minimo que o seletor precisa — o kanban usa o tipo completo. */
interface Pipeline {
  id: string;
  nome: string;
}

function lerPipelines(valor: unknown): Pipeline[] {
  if (!Array.isArray(valor)) return [];
  const saida: Pipeline[] = [];
  for (const bruto of valor) {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) continue;
    const registro = bruto as Record<string, unknown>;
    const id = texto(registro.id);
    if (id === '') continue;
    saida.push({ id, nome: texto(registro.nome) || 'Funil sem nome' });
  }
  return saida;
}

// ---------------------------------------------------------------------------
// Formatacao
// ---------------------------------------------------------------------------

const MINUTO_MS = 60 * 1000;
const HORA_MS = 60 * MINUTO_MS;
const DIA_MS = 24 * HORA_MS;

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});

/** "há N dias sem contato" — o dado que decide se vale a ligação. */
function rotuloSemContato(iso: string | null): string {
  if (!iso) return 'Sem contato registrado';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return 'Sem contato registrado';
  const dias = Math.max(0, Math.floor((Date.now() - data.getTime()) / DIA_MS));
  if (dias === 0) return 'Falaram hoje';
  return `Há ${dias} dia${dias === 1 ? '' : 's'} sem contato`;
}

interface Espera {
  rotulo: string;
  /** Classe da pilula: neutra < 3h, âmbar >= 3h, vermelha >= 24h. */
  classe: string;
}

/**
 * Quanto tempo o cliente esta no vacuo. A cor e o unico jeito de bater o olho e
 * ver quem ja passou do aceitavel sem ler numero por numero.
 */
function lerEspera(iso: string | null): Espera | null {
  if (!iso) return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  const decorrido = Math.max(0, Date.now() - data.getTime());

  let rotulo: string;
  if (decorrido < HORA_MS) {
    const min = Math.max(1, Math.floor(decorrido / MINUTO_MS));
    rotulo = `esperando há ${min} min`;
  } else if (decorrido < DIA_MS) {
    rotulo = `esperando há ${Math.floor(decorrido / HORA_MS)}h`;
  } else {
    const dias = Math.floor(decorrido / DIA_MS);
    rotulo = `esperando há ${dias}d`;
  }

  if (decorrido >= DIA_MS) {
    return {
      rotulo,
      classe: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
    };
  }
  if (decorrido >= 3 * HORA_MS) {
    return {
      rotulo,
      classe: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    };
  }
  return { rotulo, classe: 'border-border bg-muted/50 text-muted-foreground' };
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

const ACENTOS = new RegExp('[\u0300-\u036f]', 'g');

/** "João" acha "joao" e vice-versa: acento nunca some com um resultado. */
function achatar(valor: string): string {
  // Regex montada de escape ASCII: o arquivo nunca carrega marca de
  // combinacao solta, que qualquer editor distraido apagaria.
  return valor.normalize('NFD').replace(ACENTOS, '').toLowerCase();
}

function combina(item: RadarItem, termo: string): boolean {
  if (termo === '') return true;
  if (achatar(item.nome).includes(termo)) return true;
  // Telefone: compara so digito com digito, senao "(11) 9" nunca casa com o cru.
  const digitos = termo.replace(/\D/g, '');
  if (digitos !== '' && item.telefone.replace(/\D/g, '').includes(digitos)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Secoes
// ---------------------------------------------------------------------------

interface Secao {
  chave: ChaveFila;
  titulo: string;
  descricao: string;
  /** 2-3 frases no "?" — a regra em portugues de gente. */
  ajuda: string;
  /** Texto quando a fila esta vazia. */
  vazio: string;
}

const SECOES: Secao[] = [
  {
    chave: 'esperando_voce',
    titulo: 'Esperando você',
    descricao: 'Clientes que mandaram mensagem e ainda não tiveram resposta',
    ajuda:
      'Clientes cuja última mensagem ainda não foi respondida pela equipe. A lista é ordenada por quem espera há mais tempo. A cor da etiqueta avisa quando a espera passa de 3 horas (âmbar) e de 1 dia (vermelho).',
    vazio: 'Ninguém esperando resposta 🎉',
  },
  {
    chave: 'chamar_hoje',
    titulo: 'Chamar hoje',
    descricao: 'A ficha marcou uma próxima ação que já venceu',
    ajuda:
      'Leads com uma próxima ação agendada cujo horário já passou. Ou seja: você prometeu voltar a falar e o momento chegou. Assim que a conversa acontece e uma nova ação é marcada, o lead sai daqui.',
    vazio: 'Nenhum retorno pendente 🎉',
  },
  {
    chave: 'promissores',
    titulo: 'Promissores',
    descricao: 'Lead quente que parou de conversar',
    ajuda:
      'Leads marcados como quentes que ficaram alguns dias sem troca de mensagens. São os que mais valem uma cutucada: o interesse existia e o silêncio é recente.',
    vazio: 'Nenhum lead quente parado por aqui',
  },
  {
    chave: 'esfriando',
    titulo: 'Esfriando',
    descricao: 'Lead ativo parado há mais de uma semana',
    ajuda:
      'Leads ainda abertos no funil que passaram mais de uma semana sem nenhuma interação. Vale reabrir a conversa ou decidir de vez que a negociação acabou.',
    vazio: 'Nenhum lead esfriando no momento',
  },
];

const CHAVE_COLAPSO = 'radar:secoes-fechadas';

function AjudaSecao({ titulo, texto: conteudo }: { titulo: string; texto: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Como funciona a seção ${titulo}`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <p className="mb-1 text-xs font-semibold">{titulo}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{conteudo}</p>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  item: RadarItem;
  /** Um por vez: a pagina guarda o id expandido. */
  expandido: boolean;
  /** Card da fila "Esperando você": moldura âmbar e ação primária. */
  destaque?: boolean;
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
function RadarCard({ item, expandido, destaque, onAlternar, onCopiar, onAbrir }: CardProps) {
  const acaoEm = formatarData(item.proxima_acao_at);
  const msg = item.msg_sugerida.trim();
  const temperatura = rotuloTemperatura(item.temperatura).trim();
  const espera = destaque ? lerEspera(item.esperando_desde) : null;

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
          <Button
            size="sm"
            variant={destaque ? 'default' : 'outline'}
            className="flex-1"
            onClick={() => onAbrir(item.lead_id)}
          >
            <MessageSquare className="mr-1.5 h-4 w-4" />
            {destaque ? 'Responder agora' : 'Abrir conversa'}
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
    <article
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-card p-4',
        destaque
          ? 'border-amber-500/40 bg-amber-500/[0.04] shadow-sm dark:bg-amber-500/[0.06]'
          : 'border-border',
      )}
    >
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

      {/* Na fila "Esperando você" o relógio é a informação principal do card. */}
      {espera ? (
        <p
          className={cn(
            'inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
            espera.classe,
          )}
        >
          <Clock className="h-3 w-3" />
          {espera.rotulo}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {rotuloSemContato(item.ultima_interacao)}
          {acaoEm ? ` · ação marcada para ${acaoEm}` : ''}
          {item.responsavel ? ` · ${item.responsavel}` : ''}
        </p>
      )}

      {/* Tags do lead: contexto que decide a abordagem antes de abrir a ficha. */}
      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.tags.slice(0, 4).map((tag, i) => (
            <span
              key={`${i}-${tag}`}
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
        <Button
          size="sm"
          variant={destaque ? 'default' : 'outline'}
          className="flex-1"
          onClick={() => onAbrir(item.lead_id)}
        >
          <MessageSquare className="mr-1.5 h-4 w-4" />
          {destaque ? 'Responder agora' : 'Abrir conversa'}
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
// Cabecalho narrativo
// ---------------------------------------------------------------------------

function saudacaoDaHora(hora: number): string {
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

const DESTAQUE = 'font-semibold text-amber-700 dark:text-amber-400';

/**
 * O primeiro paragrafo do dia. Le como frase, nao como painel de numeros — o
 * vendedor precisa saber o que fazer, nao interpretar KPI.
 */
function ResumoNarrativo({ resumo }: { resumo: RadarResumo }) {
  // A saudacao depende do relogio do navegador: calcular no render do servidor
  // daria "Bom dia" no fuso errado e quebraria a hidratacao.
  const [saudacao, setSaudacao] = useState<string | null>(null);
  useEffect(() => setSaudacao(saudacaoDaHora(new Date().getHours())), []);

  const temPendencia = resumo.esperando > 0 || resumo.chamar_hoje > 0;

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <p className="text-base leading-relaxed">
        {saudacao && <span className="font-semibold">{saudacao}! </span>}
        {temPendencia ? (
          <>
            Você tem{' '}
            {resumo.esperando > 0 && (
              <span className={DESTAQUE}>
                {resumo.esperando}{' '}
                {resumo.esperando === 1 ? 'cliente esperando' : 'clientes esperando'} resposta
              </span>
            )}
            {resumo.esperando > 0 && resumo.chamar_hoje > 0 && ' · '}
            {resumo.chamar_hoje > 0 && (
              <>
                <span className="font-semibold">
                  {resumo.chamar_hoje} {resumo.chamar_hoje === 1 ? 'retorno' : 'retornos'}
                </span>{' '}
                {resumo.chamar_hoje === 1 ? 'marcado' : 'marcados'} para hoje
                {resumo.valor_chamar_hoje > 0 && (
                  <>
                    , somando{' '}
                    <span className="font-semibold">{BRL.format(resumo.valor_chamar_hoje)}</span>
                  </>
                )}
              </>
            )}
            .
          </>
        ) : resumo.lembrete_destaque ? (
          // Sem fila, mas com lembrete: a frase abaixo é o dia inteiro.
          <>Nenhuma pendência urgente agora — só o lembrete abaixo.</>
        ) : (
          <>Tudo em dia por aqui 🎉 Nenhuma pendência no radar.</>
        )}
      </p>

      {resumo.lembrete_destaque && (
        <p className="mt-1.5 text-sm text-muted-foreground">
          Mais urgente: <span className="font-medium text-foreground">{resumo.lembrete_destaque.nome}</span>
          {resumo.lembrete_destaque.motivo ? ` — ${resumo.lembrete_destaque.motivo}` : ''}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagina
// ---------------------------------------------------------------------------

const TODOS_OS_FUNIS = 'todos';

export default function RadarPage() {
  const router = useRouter();
  /** Um card expandido por vez — `null` = todos recolhidos. */
  const [expandidoId, setExpandidoId] = useState<string | null>(null);
  const [pipelineId, setPipelineId] = useState<string>(TODOS_OS_FUNIS);
  const [busca, setBusca] = useState('');
  /** Guarda so o que esta FECHADO: seção nova nasce aberta sem migração. */
  const [fechadas, setFechadas] = useState<string[]>([]);

  // localStorage so existe no cliente. Ler no primeiro render (mesmo com guard)
  // faria o HTML do servidor divergir do cliente — por isso o efeito.
  useEffect(() => {
    try {
      const cru: unknown = JSON.parse(window.localStorage.getItem(CHAVE_COLAPSO) ?? '[]');
      if (Array.isArray(cru)) {
        setFechadas(cru.filter((c): c is string => typeof c === 'string'));
      }
    } catch {
      /* modo privado / JSON corrompido: segue com tudo aberto. */
    }
  }, []);

  const alternarSecao = (chave: string) => {
    setFechadas((atual) => {
      const proxima = atual.includes(chave)
        ? atual.filter((c) => c !== chave)
        : [...atual, chave];
      try {
        window.localStorage.setItem(CHAVE_COLAPSO, JSON.stringify(proxima));
      } catch {
        /* sem persistencia nao e motivo pra travar o clique. */
      }
      return proxima;
    });
  };

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => lerPipelines((await api.get('/api/pipelines')).data),
    staleTime: 5 * 60_000,
  });

  const { data, isLoading, isError, isFetching, refetch } = useQuery<RadarResposta>({
    queryKey: ['radar', pipelineId],
    queryFn: async () =>
      normalizar(
        (
          await api.get('/api/insights/radar', {
            params: pipelineId === TODOS_OS_FUNIS ? undefined : { pipeline_id: pipelineId },
          })
        ).data,
      ),
    // A fila e montada por cron; recarregar a cada foco de aba nao muda nada.
    staleTime: 60_000,
    // Trocar de funil mantem a tela cheia em vez de piscar esqueleto.
    placeholderData: keepPreviousData,
  });

  const radar = data ?? VAZIO;
  const termo = achatar(busca.trim());

  /** Um filtro por render, reaproveitado pelas quatro seções. */
  const filtradas = useMemo<Record<ChaveFila, RadarItem[]>>(
    () => ({
      esperando_voce: radar.esperando_voce.filter((i) => combina(i, termo)),
      chamar_hoje: radar.chamar_hoje.filter((i) => combina(i, termo)),
      promissores: radar.promissores.filter((i) => combina(i, termo)),
      esfriando: radar.esfriando.filter((i) => combina(i, termo)),
    }),
    [radar, termo],
  );

  const totalFiltrado =
    filtradas.esperando_voce.length +
    filtradas.chamar_hoje.length +
    filtradas.promissores.length +
    filtradas.esfriando.length;

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
        subtitle="A central do dia: quem está esperando, quem chamar e quem está esfriando"
        actions={
          <Button variant="outline" size="sm" disabled={isFetching} onClick={atualizar}>
            <RefreshCw className={cn('mr-1.5 h-4 w-4', isFetching && 'animate-spin')} />
            Atualizar
          </Button>
        }
      />

      {/* Em erro NAO mostra a narrativa: "tudo em dia" em cima de um bloco de
          erro e a tela mentindo que o dia esta limpo. */}
      {isLoading ? (
        <Skeleton className="h-[88px] w-full rounded-xl" />
      ) : isError ? null : (
        <ResumoNarrativo resumo={radar.resumo} />
      )}

      {/* Controles: recortar por funil e achar alguém pelo nome. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={pipelineId} onValueChange={setPipelineId}>
          <SelectTrigger className="h-9 w-full sm:w-56" aria-label="Filtrar por funil">
            <SelectValue placeholder="Todos os funis" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TODOS_OS_FUNIS}>Todos os funis</SelectItem>
            {pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.nome}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome ou telefone…"
            aria-label="Buscar no radar"
            className="h-9 pl-9"
          />
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
        <>
          {!isLoading && termo !== '' && totalFiltrado === 0 && (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Nenhum lead do radar bate com “{busca.trim()}”.
            </p>
          )}

          {SECOES.map((secao) => {
            const itens = filtradas[secao.chave];
            const aberta = !fechadas.includes(secao.chave);
            const destaque = secao.chave === 'esperando_voce';

            return (
              <section
                key={secao.chave}
                className={cn(
                  'space-y-3',
                  destaque &&
                    'rounded-xl border-l-4 border-amber-500/70 bg-amber-500/[0.03] py-3 pl-4 pr-3 dark:bg-amber-500/[0.05]',
                )}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => alternarSecao(secao.chave)}
                    aria-expanded={aberta}
                    className="group flex min-w-0 flex-1 items-start gap-1.5 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                        aberta && 'rotate-90',
                      )}
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight group-hover:underline">
                        {destaque && <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />}
                        {secao.titulo}
                        {!isLoading && (
                          <span className="font-normal text-muted-foreground">({itens.length})</span>
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground">{secao.descricao}</span>
                    </span>
                  </button>
                  <AjudaSecao titulo={secao.titulo} texto={secao.ajuda} />
                </div>

                {aberta &&
                  (isLoading ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-44 w-full rounded-xl" />
                      ))}
                    </div>
                  ) : itens.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {termo !== '' ? 'Nenhum resultado nesta seção.' : secao.vazio}
                    </p>
                  ) : (
                    <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {itens.map((item) => (
                        <RadarCard
                          key={item.lead_id}
                          item={item}
                          destaque={destaque}
                          expandido={expandidoId === item.lead_id}
                          onAlternar={() =>
                            setExpandidoId((atual) =>
                              atual === item.lead_id ? null : item.lead_id,
                            )
                          }
                          onCopiar={copiar}
                          onAbrir={(leadId) => router.push(`/chat/${leadId}`)}
                        />
                      ))}
                    </div>
                  ))}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
