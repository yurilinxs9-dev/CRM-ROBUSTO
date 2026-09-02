'use client';

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Banknote,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  HelpCircle,
  Clock,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  ShoppingBag,
  Target,
  X,
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

/** A compra que o cliente citou na conversa, extraida pela ficha do lead. */
export interface RadarCompra {
  descricao: string;
  /** `null` quando o cliente falou da compra mas nao do preco. */
  valor: number | null;
  /** Texto livre da ficha ("mês passado") ou uma data ISO. */
  quando: string;
}

/**
 * `GET /api/insights/radar?pipeline_id=<uuid opcional>` devolve as seis filas
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
  /** Valor da negociacao. `null` = ninguem preencheu ainda (nao e zero). */
  valor_estimado: number | null;
  /** Nota de 0 a 10 que a ficha deu ao atendimento. `null` = nao avaliado. */
  nota_atendimento: number | null;
  /** `null` em todo mundo que ainda nao comprou. */
  compra: RadarCompra | null;
}

/**
 * Um compromisso que o PROPRIO cliente deu na conversa ("me chama em outubro"):
 * a ficha extraiu, o banco guardou e hoje e o dia de voltar a falar. `motivo` e
 * `dito_em` sao o contexto original — e o que faz a mensagem do vendedor nao
 * parecer robo. Fase 3: backend antigo nao manda a chave e a seção some.
 */
export interface RadarLembrete {
  lembrete_id: string;
  motivo: string;
  dito_em: string;
  avisar_em: string;
  /** O lead inteiro, no mesmo formato das outras filas. */
  lead: RadarItem;
}

export interface RadarResumo {
  esperando: number;
  chamar_hoje: number;
  valor_chamar_hoje: number;
  lembrete_destaque: { nome: string; motivo: string } | null;
  /** Fase 3: quantos compromissos vencem hoje. `0` em backend antigo. */
  lembretes_hoje: number;
}

export interface RadarResposta {
  resumo: RadarResumo;
  esperando_voce: RadarItem[];
  chamar_hoje: RadarItem[];
  promissores: RadarItem[];
  esfriando: RadarItem[];
  /**
   * Ranking transversal do dia (top 10). O MESMO lead pode aparecer aqui e em
   * outra fila — e de proposito: isto e um recorte, nao uma quinta caixa de
   * pendencias. O score que ordena fica no servidor e NAO vem no payload.
   */
  melhores: RadarItem[];
  /** Quem ja fechou (etapa de ganho ou compra na ficha), ate 30. */
  compraram: RadarItem[];
  /**
   * Fase 3. NAO e uma fila de `RadarItem`: cada linha carrega o lembrete (o que
   * o cliente disse e quando) com o lead dentro — por isso fica fora de
   * `ChaveFila` e tem filtro/contador proprios.
   */
  lembretes_hoje: RadarLembrete[];
}

/** Chaves que guardam filas — o `resumo` fica de fora de proposito. */
type ChaveFila =
  | 'esperando_voce'
  | 'chamar_hoje'
  | 'promissores'
  | 'esfriando'
  | 'melhores'
  | 'compraram';

const RESUMO_ZERADO: RadarResumo = {
  esperando: 0,
  chamar_hoje: 0,
  valor_chamar_hoje: 0,
  lembrete_destaque: null,
  lembretes_hoje: 0,
};

const VAZIO: RadarResposta = {
  resumo: RESUMO_ZERADO,
  esperando_voce: [],
  chamar_hoje: [],
  promissores: [],
  esfriando: [],
  melhores: [],
  compraram: [],
  lembretes_hoje: [],
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

/**
 * `valor_estimado` e Decimal no Prisma. O backend serializa em number, mas um
 * Decimal cru chega como string — aceita os dois e recusa o resto. `null`
 * (ninguem preencheu) e diferente de `0` (negociacao de graca), por isso este
 * helper existe em vez do `numero()` acima.
 */
function numeroOuNulo(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim() !== '') {
    const convertido = Number(valor);
    return Number.isFinite(convertido) ? convertido : null;
  }
  return null;
}

/** Compra vazia (`{}` de ficha antiga) nao e compra: vira `null` e o card cai
 *  no texto generico em vez de mostrar "Comprou:" sem nada depois. */
function lerCompra(valor: unknown): RadarCompra | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
  const registro = valor as Record<string, unknown>;
  const descricao = texto(registro.descricao).trim();
  const preco = numeroOuNulo(registro.valor);
  const quando = texto(registro.quando).trim();
  if (descricao === '' && preco === null && quando === '') return null;
  return { descricao, valor: preco, quando };
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
      // Campos da Fase 2: backend antigo nao manda nenhum dos tres e cada um
      // cai no `null`, que ja e o estado "a linha some do card".
      valor_estimado: numeroOuNulo(registro.valor_estimado),
      nota_atendimento: numeroOuNulo(registro.nota_atendimento),
      compra: lerCompra(registro.compra),
    });
  }
  return saida;
}

/**
 * Lembretes de hoje. Cada linha so vale se tiver id, uma data de aviso e um
 * lead legivel — reaproveita `lerItens` para o lead de dentro, que e o mesmo
 * formato das outras filas. Linha quebrada e pulada em vez de derrubar a seção.
 */
function lerLembretes(valor: unknown): RadarLembrete[] {
  if (!Array.isArray(valor)) return [];
  const saida: RadarLembrete[] = [];
  for (const bruto of valor) {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) continue;
    const registro = bruto as Record<string, unknown>;
    const id = texto(registro.lembrete_id);
    const avisarEm = texto(registro.avisar_em);
    if (id === '' || avisarEm === '') continue;
    const [lead] = lerItens([registro.lead]);
    if (!lead) continue;
    saida.push({
      lembrete_id: id,
      motivo: texto(registro.motivo),
      dito_em: texto(registro.dito_em),
      avisar_em: avisarEm,
      lead,
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
function lerResumo(
  valor: unknown,
  filas: Record<ChaveFila, RadarItem[]>,
  lembretes: RadarLembrete[],
): RadarResumo {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return {
      esperando: filas.esperando_voce.length,
      chamar_hoje: filas.chamar_hoje.length,
      valor_chamar_hoje: 0,
      lembrete_destaque: null,
      lembretes_hoje: lembretes.length,
    };
  }
  const registro = valor as Record<string, unknown>;
  const contagemLembretes = numero(registro.lembretes_hoje);
  return {
    esperando: numero(registro.esperando),
    chamar_hoje: numero(registro.chamar_hoje),
    valor_chamar_hoje: numero(registro.valor_chamar_hoje),
    lembrete_destaque: lerDestaque(registro.lembrete_destaque),
    // Backend em versao intermediaria pode mandar a LISTA sem o contador no
    // resumo: a frase do topo conta a lista em vez de dizer zero com a seção
    // cheia logo abaixo.
    lembretes_hoje: contagemLembretes > 0 ? contagemLembretes : lembretes.length,
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
    // Backend anterior a Fase 2 nao tem estas duas chaves: viram lista vazia e
    // as secoes novas simplesmente nao aparecem.
    melhores: lerItens(registro.melhores),
    compraram: lerItens(registro.compraram),
  };
  // Fase 3: backend anterior nao tem a chave — lista vazia e a seção some.
  const lembretes = lerLembretes(registro.lembretes_hoje);
  return {
    ...filas,
    lembretes_hoje: lembretes,
    resumo: lerResumo(registro.resumo, filas, lembretes),
  };
}

/** So o minimo que o seletor precisa — o kanban usa o tipo completo. */
interface Pipeline {
  id: string;
  nome: string;
  arquivado?: boolean;
}

/**
 * Funil arquivado nao entra no seletor: ele some do kanban, entao oferecer o
 * filtro aqui so entrega uma lista vazia sem explicacao.
 */
function lerPipelines(valor: unknown): Pipeline[] {
  if (!Array.isArray(valor)) return [];
  const saida: Pipeline[] = [];
  for (const bruto of valor) {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) continue;
    const registro = bruto as Record<string, unknown>;
    const id = texto(registro.id);
    if (id === '') continue;
    const arquivado = registro.arquivado === true;
    if (arquivado) continue;
    saida.push({ id, nome: texto(registro.nome) || 'Funil sem nome', arquivado });
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

const ISO_DATA = new RegExp('^\\d{4}-\\d{2}-\\d{2}');

/**
 * `compra.quando` e texto livre da ficha ("mês passado", "na semana do Natal").
 * So formata quando o modelo devolveu uma data de verdade — o resto passa como
 * veio, que e justamente a frase que o cliente disse.
 */
function rotuloQuando(valor: string): string {
  const bruto = valor.trim();
  if (bruto === '' || !ISO_DATA.test(bruto)) return bruto;
  const data = new Date(bruto);
  if (Number.isNaN(data.getTime())) return bruto;
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** "Comprou: Mesa Requinte · R$ 3.990 · mês passado". */
function linhaCompra(compra: RadarCompra | null): string {
  // Lead que veio pela etapa de ganho, sem compra descrita na conversa.
  if (compra === null) return 'Cliente fechado';
  const descricao = compra.descricao.trim();
  const partes: string[] = [descricao === '' ? 'Comprou' : `Comprou: ${descricao}`];
  // Compra de R$ 0 e ruido de extracao: melhor omitir do que anunciar zero.
  if (compra.valor !== null && compra.valor > 0) partes.push(BRL.format(compra.valor));
  const quando = rotuloQuando(compra.quando);
  if (quando !== '') partes.push(quando);
  return partes.join(' · ');
}

/**
 * Convencao selada com o backend: `avisar_em` chega como o instante ISO da
 * MEIA-NOITE em Sao Paulo. Logo, o dia do lembrete e sempre lido no fuso de SP
 * — nunca no do navegador. Vendedor em Lisboa (ou com o relogio do notebook em
 * UTC) tem que ver a MESMA data que o cliente combinou.
 */
const FUSO = 'America/Sao_Paulo';

/** "27/10" — a data curta que cabe dentro da frase do lembrete. */
function diaMes(iso: string): string | null {
  if (iso.trim() === '') return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: FUSO });
}

/** O dia-calendario em SP como "AAAA-MM-DD" — texto que ordena sozinho. */
function diaEmSaoPaulo(data: Date): string {
  return data.toLocaleDateString('en-CA', { timeZone: FUSO });
}

/**
 * O lembrete venceu antes de hoje. Compara DIA com DIA, os dois no fuso de SP:
 * um lembrete de hoje de manha nao pode aparecer em vermelho as 15h so porque a
 * hora ja passou, nem um lembrete de amanha ficar vermelho porque o navegador
 * esta num fuso a frente.
 */
function lembreteAtrasado(iso: string): boolean {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return false;
  return diaEmSaoPaulo(data) < diaEmSaoPaulo(new Date());
}

/** Mensagem que o backend mandou no erro, quando ela existe. */
function mensagemDoErro(err: unknown): string | undefined {
  const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof msg === 'string' && msg.trim() !== '' ? msg : undefined;
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
// Onde esta o dinheiro — agrupamento por etapa
// ---------------------------------------------------------------------------

interface GrupoEtapa {
  etapa: string;
  total: number;
  /** Soma de `valor_estimado`. `0` = ninguem preencheu valor nessa etapa. */
  valor: number;
}

const SEM_ETAPA = 'Sem etapa';

/** Lead sem etapa vira um grupo proprio em vez de sumir da conta. */
function etapaDe(item: RadarItem): string {
  return item.etapa.trim() === '' ? SEM_ETAPA : item.etapa.trim();
}

/**
 * `Map` e nao objeto literal: nome de etapa e texto que o usuario escolhe, e
 * `"constructor"` como chave de objeto devolveria uma funcao no lugar do grupo.
 */
function agruparPorEtapa(itens: RadarItem[]): GrupoEtapa[] {
  const mapa = new Map<string, GrupoEtapa>();
  for (const item of itens) {
    const etapa = etapaDe(item);
    const grupo = mapa.get(etapa) ?? { etapa, total: 0, valor: 0 };
    grupo.total += 1;
    grupo.valor += item.valor_estimado ?? 0;
    mapa.set(etapa, grupo);
  }
  // Maior bolo primeiro — a pergunta da secao e "onde esta o dinheiro".
  return [...mapa.values()].sort(
    (a, b) => b.valor - a.valor || b.total - a.total || a.etapa.localeCompare(b.etapa, 'pt-BR'),
  );
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

/** Textos das tres experiencias da Fase 2 (fora de `SECOES`: elas nao sao
 *  listas de card padrao — cada uma tem corpo proprio). */
const AJUDA_DINHEIRO =
  'Os leads de "Promissores" agrupados pela etapa em que estão. O valor é a soma do valor estimado de cada um; etapa em que ninguém preencheu valor aparece com um traço. Clique numa etapa para ver só os leads dela e clique de novo para voltar à lista inteira.';

/** O subtitulo diz de ONDE vem a escolha (a analise das conversas) e QUAIS
 *  sinais pesam. Nunca um numero de score: placar na tela vira cara de robo. */
const FOCO_DESCRICAO =
  'Escolhidos pela análise das conversas: o retorno que você marcou, a atividade recente, o valor e o atendimento';

const AJUDA_FOCO =
  'Uma lista curta com os leads que mais merecem sua atenção hoje. A escolha sai da análise das fichas — do que foi conversado com cada cliente. O que pesa mais é o retorno que você mesmo marcou na agenda; depois vêm há quanto tempo vocês trocaram mensagem, o quanto o lead está quente, o valor estimado da negociação e a nota do atendimento. Um lead daqui pode aparecer também nas outras seções: é de propósito, esta é uma vitrine, não mais uma fila de pendências.';

const AJUDA_COMPRARAM =
  'Clientes que já fecharam: leads em etapa de ganho ou com uma compra registrada na ficha. Serve para o pós-venda — agradecer, pedir indicação ou oferecer o próximo produto. Mostra os mais recentes primeiro.';

const AJUDA_LEMBRETES =
  'Compromissos que o próprio cliente deu na conversa — o CRM avisa na data certa.';

const LEMBRETES_DESCRICAO = 'O cliente pediu para você voltar a falar hoje';

const CHAVE_COLAPSO = 'radar:secoes-fechadas';
/** Chave propria: "Compraram" nasce FECHADA, e a lista de `CHAVE_COLAPSO`
 *  guarda so o que esta fechado — a semantica invertida nao caberia la sem
 *  migrar o que ja esta no navegador de todo mundo. */
const CHAVE_POS_VENDA = 'radar:compraram-aberta';

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

interface CabecalhoProps {
  titulo: string;
  descricao: string;
  ajuda: string;
  /** Ja formatado ("(3 de 12)"). `null` esconde o contador (carregando). */
  contagem: string | null;
  aberta: boolean;
  onAlternar: () => void;
  icone?: ReactNode;
}

/**
 * Padrao accordion: o `<h3>` envolve o gatilho para o leitor de tela pular de
 * seção em seção pela lista de headings.
 */
function CabecalhoSecao({
  titulo,
  descricao,
  ajuda,
  contagem,
  aberta,
  onAlternar,
  icone,
}: CabecalhoProps) {
  return (
    <div className="flex items-start gap-2">
      <h3 className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onAlternar}
          aria-expanded={aberta}
          className="group flex w-full min-w-0 items-start gap-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              aberta && 'rotate-90',
            )}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight group-hover:underline">
              {icone}
              {titulo}
              {contagem && <span className="font-normal text-muted-foreground">{contagem}</span>}
            </span>
            <span className="block text-xs text-muted-foreground">{descricao}</span>
          </span>
        </button>
      </h3>
      <AjudaSecao titulo={titulo} texto={ajuda} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * O bloco da mensagem pronta. Truncado na tela; o botao copia o texto inteiro.
 * Texto de LLM — renderiza SO como texto React (ver `RadarCard`).
 */
function MensagemSugerida({ msg, onCopiar }: { msg: string; onCopiar: (valor: string) => void }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-2.5">
      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        Mensagem sugerida
      </p>
      <p className="line-clamp-2 text-sm" title={msg}>
        {msg}
      </p>
      <Button size="sm" variant="ghost" className="mt-1.5 h-7 px-2 text-xs" onClick={() => onCopiar(msg)}>
        <Copy className="mr-1 h-3.5 w-3.5" />
        Copiar
      </Button>
    </div>
  );
}

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
            valor_estimado: item.valor_estimado,
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
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              espera.classe,
            )}
          >
            <Clock className="h-3 w-3" />
            {espera.rotulo}
          </span>
          {/* Multi-operador: saber de quem e o lead sem abrir a ficha decide se
              o vendedor responde ou deixa pro dono. */}
          {item.responsavel && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              · {item.responsavel}
            </span>
          )}
        </div>
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

      {msg && <MensagemSugerida msg={msg} onCopiar={onCopiar} />}

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
// Onde esta o dinheiro
// ---------------------------------------------------------------------------

interface BlocoDinheiroProps {
  grupos: GrupoEtapa[];
  /** Etapa selecionada, ou `null` com a lista de promissores inteira. */
  etapaAtiva: string | null;
  onSelecionar: (etapa: string) => void;
}

/**
 * Bloco compacto de leitura de gestor: quanto tem parado em cada etapa. Nao
 * repete card nenhum — cada pilula e um atalho que recorta a seção Promissores.
 */
function BlocoDinheiro({ grupos, etapaAtiva, onSelecionar }: BlocoDinheiroProps) {
  const leads = grupos.reduce((soma, g) => soma + g.total, 0);
  const total = grupos.reduce((soma, g) => soma + g.valor, 0);

  return (
    <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-4 dark:bg-emerald-500/[0.07]">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Banknote className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            Onde está o dinheiro
          </h3>
          <p className="text-xs text-muted-foreground">
            {leads} {leads === 1 ? 'lead promissor' : 'leads promissores'}
            {total > 0 ? (
              <>
                {' '}
                somando <span className="font-medium text-foreground">{BRL.format(total)}</span>
              </>
            ) : (
              ' — nenhum valor estimado preenchido ainda'
            )}
            . Clique numa etapa para ver só ela.
          </p>
        </div>
        <AjudaSecao titulo="Onde está o dinheiro" texto={AJUDA_DINHEIRO} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {grupos.map((grupo) => {
          const ativa = grupo.etapa === etapaAtiva;
          return (
            <button
              key={grupo.etapa}
              type="button"
              aria-pressed={ativa}
              onClick={() => onSelecionar(grupo.etapa)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                ativa
                  ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500 dark:text-emerald-950'
                  : 'border-border bg-card hover:border-emerald-500/50 hover:bg-emerald-500/10',
              )}
            >
              <span className="font-medium">{grupo.etapa}</span>
              {/* `opacity` no lugar de `text-muted-foreground`: a pilula ativa
                  tem fundo cheio e o cinza do tema sumiria dentro dele. */}
              <span className="opacity-70">
                {' · '}
                {grupo.total} {grupo.total === 1 ? 'lead' : 'leads'}
                {' · '}
              </span>
              {/* Etapa sem nenhum valor preenchido mostra traço, nao "R$ 0". */}
              <span className="font-semibold">{grupo.valor > 0 ? BRL.format(grupo.valor) : '—'}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Foco do dia
// ---------------------------------------------------------------------------

/**
 * Card enxuto do ranking: nome, etapa, temperatura, valor e uma linha de
 * contexto. NAO mostra numero de score em lugar nenhum — a ordem ja e a
 * informacao, e um "8,4" na tela so pareceria placar de robo.
 */
function CardFoco({ item, onAbrir }: { item: RadarItem; onAbrir: (leadId: string) => void }) {
  const temperatura = rotuloTemperatura(item.temperatura).trim();
  const contexto = item.motivo.trim() || item.msg_sugerida.trim();
  const valor = item.valor_estimado !== null && item.valor_estimado > 0 ? item.valor_estimado : null;

  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/chat/${item.lead_id}`}
          className="min-w-0 truncate text-sm font-medium hover:underline"
        >
          {item.nome}
        </Link>
        {temperatura && (
          <span
            className={cn(
              'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              classeTemperatura(item.temperatura),
            )}
          >
            {temperatura}
          </span>
        )}
      </div>

      {(item.etapa || valor !== null) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {item.etapa && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {item.etapa}
            </span>
          )}
          {valor !== null && <span className="text-[11px] font-semibold">{BRL.format(valor)}</span>}
        </div>
      )}

      {contexto && (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={contexto}>
          {contexto}
        </p>
      )}

      <Button
        size="sm"
        variant="outline"
        className="mt-auto h-8 w-full text-xs"
        onClick={() => onAbrir(item.lead_id)}
      >
        <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
        Abrir conversa
      </Button>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Compraram
// ---------------------------------------------------------------------------

interface CardCompraProps {
  item: RadarItem;
  expandido: boolean;
  onAlternar: () => void;
  onCopiar: (valor: string) => void;
  onAbrir: (leadId: string) => void;
}

/** A compra em destaque verde é o motivo do card existir: o vendedor precisa
 *  saber o que a pessoa levou antes de escrever qualquer coisa. */
function CardCompra({ item, expandido, onAlternar, onCopiar, onAbrir }: CardCompraProps) {
  const msg = item.msg_sugerida.trim();

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
            valor_estimado: item.valor_estimado,
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
    <article className="flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-card p-4">
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
        {item.etapa && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            {item.etapa}
          </span>
        )}
      </div>

      <p className="flex items-start gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-sm font-medium text-emerald-800 dark:text-emerald-300">
        <ShoppingBag className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">{linhaCompra(item.compra)}</span>
      </p>

      <p className="text-xs text-muted-foreground">
        {rotuloSemContato(item.ultima_interacao)}
        {item.responsavel ? ` · ${item.responsavel}` : ''}
      </p>

      {msg && <MensagemSugerida msg={msg} onCopiar={onCopiar} />}

      <div className="mt-auto flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={() => onAbrir(item.lead_id)}>
          <MessageSquare className="mr-1.5 h-4 w-4" />
          Abrir conversa
        </Button>
        <Button size="sm" variant="ghost" onClick={onAlternar} aria-expanded={false}>
          <ChevronDown className="mr-1.5 h-4 w-4" />
          Ver ficha completa
        </Button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Lembretes de hoje
// ---------------------------------------------------------------------------

/** Os tres adiamentos oferecidos no popover — dias e rotulo juntos. */
const ADIAMENTOS: { dias: number; rotulo: string }[] = [
  { dias: 1, rotulo: '+1 dia' },
  { dias: 7, rotulo: '+7 dias' },
  { dias: 30, rotulo: '+30 dias' },
];

type AcaoLembrete = 'concluir' | 'adiar' | 'descartar';

interface PedidoLembrete {
  id: string;
  acao: AcaoLembrete;
  /** So em `adiar`. */
  dias?: number;
}

/**
 * Card do compromisso do dia. As mutacoes vivem AQUI dentro, uma instancia por
 * card: e o que da a trava por lembrete — clicar em "Concluir" num card nao
 * desabilita os botoes dos outros, e o card que acabou de resolver segue
 * travado ate o refetch tirar ele da tela.
 *
 * `motivo` e a fala do cliente lida pela IA: renderiza SO como texto React.
 */
function CardLembrete({
  lembrete,
  onAbrir,
}: {
  lembrete: RadarLembrete;
  onAbrir: (leadId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [adiarAberto, setAdiarAberto] = useState(false);
  const item = lembrete.lead;
  const temperatura = rotuloTemperatura(item.temperatura).trim();
  const ditoEm = diaMes(lembrete.dito_em);
  const avisarEm = diaMes(lembrete.avisar_em);
  const atrasado = lembreteAtrasado(lembrete.avisar_em);
  const motivo = lembrete.motivo.trim();

  const agir = useMutation<void, unknown, PedidoLembrete>({
    mutationFn: async ({ id, acao, dias }) => {
      if (acao === 'adiar') {
        await api.post(`/api/lembretes/${id}/adiar`, { dias });
        return;
      }
      await api.post(`/api/lembretes/${id}/${acao}`);
    },
    onSuccess: (_dados, pedido) => {
      if (pedido.acao === 'concluir') toast.success('Lembrete concluído');
      else if (pedido.acao === 'descartar') toast.success('Lembrete descartado');
      else toast.success(`Lembrete adiado ${pedido.dias === 1 ? '1 dia' : `${pedido.dias} dias`}`);
      void queryClient.invalidateQueries({ queryKey: ['radar'] });
      // A ficha 360 abre DENTRO do radar (card expandido) e mostra a mesma
      // lista: sem esta invalidacao o lembrete resolvido aqui continuaria
      // pendente la, na mesma tela.
      void queryClient.invalidateQueries({ queryKey: ['lead-lembretes', item.lead_id] });
    },
    onError: (err: unknown) => {
      toast.error(mensagemDoErro(err) ?? 'Não foi possível atualizar o lembrete.');
    },
    // Fecha o popover de adiar nos DOIS caminhos: no erro ele ficaria aberto
    // por cima do toast, escondendo justamente a explicacao da falha.
    onSettled: () => setAdiarAberto(false),
  });

  /**
   * Continua travado DEPOIS do sucesso: entre o fim do POST e o refetch que
   * apaga o card existe uma janela em que ele ainda esta na tela — sem isto um
   * segundo clique bateria num lembrete que ja foi resolvido (404).
   */
  const resolvido =
    agir.isPending || (agir.isSuccess && agir.variables?.id === lembrete.lembrete_id);
  const emAndamento = (acao: AcaoLembrete) => agir.isPending && agir.variables?.acao === acao;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-violet-500/40 bg-violet-500/[0.04] p-4 shadow-sm dark:bg-violet-500/[0.07]">
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

      {/* O contexto original e o motivo do card existir: sem a fala do cliente
          o vendedor liga sem saber por que. */}
      {motivo !== '' && (
        <p className="rounded-lg border border-violet-500/40 bg-violet-500/10 p-2.5 text-sm leading-relaxed text-violet-900 dark:text-violet-200">
          {ditoEm ? `Em ${ditoEm} ele disse: ` : 'Ele disse: '}
          <span className="font-medium">{`"${motivo}"`}</span>
        </p>
      )}

      {avisarEm && (
        <p
          className={cn(
            'flex items-center gap-1.5 text-xs font-medium',
            atrasado ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
          )}
        >
          <CalendarClock className="h-3.5 w-3.5 shrink-0" />
          Voltar a falar: {avisarEm}
          {atrasado && ' (atrasado)'}
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        {/* Nao trava com `resolvido`: abrir a conversa e navegacao, nao mutacao
            — quem acabou de concluir ainda pode querer mandar a mensagem. */}
        <Button size="sm" className="flex-1" onClick={() => onAbrir(item.lead_id)}>
          <MessageSquare className="mr-1.5 h-4 w-4" />
          Abrir conversa
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={resolvido}
          onClick={() => agir.mutate({ id: lembrete.lembrete_id, acao: 'concluir' })}
        >
          {emAndamento('concluir') ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-4 w-4" />
          )}
          Concluir
        </Button>
        <Popover open={adiarAberto} onOpenChange={setAdiarAberto}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" disabled={resolvido}>
              {emAndamento('adiar') ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <CalendarClock className="mr-1.5 h-4 w-4" />
              )}
              Adiar
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-40 p-1">
            {ADIAMENTOS.map((opcao) => (
              <button
                key={opcao.dias}
                type="button"
                disabled={resolvido}
                onClick={() =>
                  agir.mutate({ id: lembrete.lembrete_id, acao: 'adiar', dias: opcao.dias })
                }
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                {opcao.rotulo}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          variant="ghost"
          disabled={resolvido}
          onClick={() => agir.mutate({ id: lembrete.lembrete_id, acao: 'descartar' })}
        >
          {emAndamento('descartar') ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <X className="mr-1.5 h-4 w-4" />
          )}
          Descartar
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

/** Mesmo roxo da seção de lembretes: a frase e a seção falam do mesmo assunto. */
const DESTAQUE_LEMBRETE = 'font-semibold text-violet-700 dark:text-violet-400';

/**
 * O primeiro paragrafo do dia. Le como frase, nao como painel de numeros — o
 * vendedor precisa saber o que fazer, nao interpretar KPI.
 */
function ResumoNarrativo({ resumo }: { resumo: RadarResumo }) {
  // A saudacao depende do relogio do navegador: calcular no render do servidor
  // daria "Bom dia" no fuso errado e quebraria a hidratacao.
  const [saudacao, setSaudacao] = useState<string | null>(null);
  useEffect(() => setSaudacao(saudacaoDaHora(new Date().getHours())), []);

  // Lembrete de hoje TAMBEM e pendencia: sem isto a frase diria "tudo em dia"
  // com a seção roxa cheia logo abaixo.
  const temPendencia =
    resumo.esperando > 0 || resumo.chamar_hoje > 0 || resumo.lembretes_hoje > 0;
  /** Ha algo antes do trecho dos lembretes? Decide o " · " de ligacao. */
  const antesDoLembrete = resumo.esperando > 0 || resumo.chamar_hoje > 0;

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
            {resumo.lembretes_hoje > 0 && (
              <>
                {antesDoLembrete && ' · '}
                <span className={DESTAQUE_LEMBRETE}>
                  {resumo.lembretes_hoje}{' '}
                  {resumo.lembretes_hoje === 1 ? 'lembrete' : 'lembretes'}
                </span>{' '}
                que o cliente pediu para hoje
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
  /** Etapa escolhida em "Onde está o dinheiro" — recorta os Promissores. */
  const [etapaFiltro, setEtapaFiltro] = useState<string | null>(null);
  /** "Compraram" e a unica que nasce fechada: e consulta, nao pendencia. */
  const [posVendaAberta, setPosVendaAberta] = useState(false);

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
    try {
      setPosVendaAberta(window.localStorage.getItem(CHAVE_POS_VENDA) === 'true');
    } catch {
      /* sem localStorage a seção segue fechada, que e o padrao. */
    }
  }, []);

  const alternarPosVenda = () => {
    setPosVendaAberta((atual) => {
      const proxima = !atual;
      try {
        window.localStorage.setItem(CHAVE_POS_VENDA, proxima ? 'true' : 'false');
      } catch {
        /* sem persistencia nao e motivo pra travar o clique. */
      }
      return proxima;
    });
  };

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
    queryKey: ['pipelines', 'radar-resumo'],
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

  /** Um filtro por render, reaproveitado pelas seis seções. */
  const porBusca = useMemo<Record<ChaveFila, RadarItem[]>>(
    () => ({
      esperando_voce: radar.esperando_voce.filter((i) => combina(i, termo)),
      chamar_hoje: radar.chamar_hoje.filter((i) => combina(i, termo)),
      promissores: radar.promissores.filter((i) => combina(i, termo)),
      esfriando: radar.esfriando.filter((i) => combina(i, termo)),
      melhores: radar.melhores.filter((i) => combina(i, termo)),
      compraram: radar.compraram.filter((i) => combina(i, termo)),
    }),
    [radar, termo],
  );

  /** Lembretes ficam fora de `porBusca` (tipo proprio), mas obedecem a MESMA
   *  busca — pelo lead de dentro — e o mesmo seletor de funil (que ja recorta
   *  no servidor, via `queryKey`). */
  const lembretesFiltrados = useMemo(
    () => radar.lembretes_hoje.filter((l) => combina(l.lead, termo)),
    [radar.lembretes_hoje, termo],
  );

  // Os grupos saem do que a BUSCA deixou passar, nunca do recorte por etapa —
  // senao clicar numa pilula apagaria todas as outras da tela.
  const grupos = useMemo(() => agruparPorEtapa(porBusca.promissores), [porBusca.promissores]);

  /**
   * Se a busca mudou e a etapa escolhida sumiu dos grupos, o filtro se desfaz
   * sozinho — sem isso a seção ficaria vazia sem nada clicavel pra desfazer.
   */
  const etapaAtiva = grupos.some((g) => g.etapa === etapaFiltro) ? etapaFiltro : null;

  const filtradas = useMemo<Record<ChaveFila, RadarItem[]>>(
    () => ({
      ...porBusca,
      promissores:
        etapaAtiva === null
          ? porBusca.promissores
          : porBusca.promissores.filter((i) => etapaDe(i) === etapaAtiva),
    }),
    [porBusca, etapaAtiva],
  );

  // Conta o resultado da BUSCA (nao o do recorte por etapa): o aviso la em cima
  // fala sobre o termo digitado.
  const totalFiltrado =
    porBusca.esperando_voce.length +
    porBusca.chamar_hoje.length +
    porBusca.promissores.length +
    porBusca.esfriando.length +
    porBusca.melhores.length +
    porBusca.compraram.length +
    lembretesFiltrados.length;

  const buscando = termo !== '';
  /** Busca ativa e nenhuma seção com resultado: um aviso só, no topo. */
  const buscaSemResultado = buscando && totalFiltrado === 0;

  /** O termo bate SO em "Compraram" — que nasce fechada. Sem abrir, a busca
   *  entrega uma pagina em branco e nenhum aviso (o "nada encontrado" nao vale,
   *  pois tem resultado). */
  const soNosCompradores =
    buscando && porBusca.compraram.length > 0 && porBusca.compraram.length === totalFiltrado;

  // `soNosCompradores` e a UNICA dependencia de proposito: se `posVendaAberta`
  // entrasse aqui, fechar a seção com a busca ainda ativa a reabriria na hora.
  // Nao persiste no localStorage — abertura automatica nao e escolha do usuario.
  useEffect(() => {
    if (soNosCompradores) setPosVendaAberta(true);
  }, [soNosCompradores]);

  /** Card expandido e identificado por seção + lead: o mesmo lead pode estar em
   *  duas filas, e sem o prefixo as duas fichas abririam de uma vez. */
  const chaveCard = (secao: ChaveFila, leadId: string) => `${secao}:${leadId}`;

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
        subtitle="A central do dia: quem está esperando, onde está o dinheiro e quem já comprou"
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
          {!isLoading && buscaSemResultado && (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Nenhum lead do radar bate com “{busca.trim()}”.
            </p>
          )}

          {SECOES.map((secao) => {
            const itens = filtradas[secao.chave];
            const total = radar[secao.chave].length;
            const aberta = !fechadas.includes(secao.chave);
            const destaque = secao.chave === 'esperando_voce';
            // Promissores tambem "filtra" pela pilula de etapa — o contador
            // precisa dizer "N de total" nos dois casos, nao so na busca.
            const recortada =
              buscando || (secao.chave === 'promissores' && etapaAtiva !== null);

            const bloco = (
              <section
                className={cn(
                  'space-y-3',
                  destaque &&
                    'rounded-xl border-l-4 border-amber-500/70 bg-amber-500/[0.03] py-3 pl-4 pr-3 dark:bg-amber-500/[0.05]',
                )}
              >
                <CabecalhoSecao
                  titulo={secao.titulo}
                  descricao={secao.descricao}
                  ajuda={secao.ajuda}
                  contagem={
                    isLoading ? null : recortada ? `(${itens.length} de ${total})` : `(${total})`
                  }
                  aberta={aberta}
                  onAlternar={() => alternarSecao(secao.chave)}
                  icone={
                    destaque ? (
                      <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    ) : undefined
                  }
                />

                {/* Recorte por etapa vindo de "Onde está o dinheiro": a saida
                    fica AQUI, colada na lista que ele encolheu. */}
                {aberta && secao.chave === 'promissores' && etapaAtiva !== null && (
                  <p className="text-xs text-muted-foreground">
                    Mostrando só a etapa{' '}
                    <span className="font-medium text-foreground">{etapaAtiva}</span>.{' '}
                    <button
                      type="button"
                      onClick={() => setEtapaFiltro(null)}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Ver todas
                    </button>
                  </p>
                )}

                {aberta &&
                  (isLoading ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-44 w-full rounded-xl" />
                      ))}
                    </div>
                  ) : itens.length === 0 ? (
                    // Busca que nao achou NADA ja tem o aviso unico la em cima:
                    // repetir aqui encheria a tela com quatro "nada encontrado".
                    buscaSemResultado ? null : (
                      <p className="text-sm text-muted-foreground">
                        {buscando ? 'Nenhum resultado nesta seção.' : secao.vazio}
                      </p>
                    )
                  ) : (
                    <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {itens.map((item) => (
                        <RadarCard
                          key={item.lead_id}
                          item={item}
                          destaque={destaque}
                          expandido={expandidoId === chaveCard(secao.chave, item.lead_id)}
                          onAlternar={() =>
                            setExpandidoId((atual) => {
                              const alvo = chaveCard(secao.chave, item.lead_id);
                              return atual === alvo ? null : alvo;
                            })
                          }
                          onCopiar={copiar}
                          onAbrir={(leadId) => router.push(`/chat/${leadId}`)}
                        />
                      ))}
                    </div>
                  ))}
              </section>
            );

            // As duas experiencias de gestor entram DEPOIS da urgencia: quem
            // abre o radar resolve primeiro quem esta esperando, e so entao
            // olha o funil e o foco do dia.
            if (secao.chave !== 'esperando_voce') {
              return <Fragment key={secao.chave}>{bloco}</Fragment>;
            }

            return (
              <Fragment key={secao.chave}>
                {bloco}

                {/* Lembretes vem logo depois de quem esta esperando: os dois
                    sao hora marcada. Backend anterior a Fase 3 devolve a chave
                    ausente — a lista fica vazia e a seção inteira some. */}
                {!isLoading && radar.lembretes_hoje.length > 0 && (
                  <section className="space-y-3 rounded-xl border-l-4 border-violet-500/70 bg-violet-500/[0.03] py-3 pl-4 pr-3 dark:bg-violet-500/[0.05]">
                    <CabecalhoSecao
                      titulo="Lembretes de hoje"
                      descricao={LEMBRETES_DESCRICAO}
                      ajuda={AJUDA_LEMBRETES}
                      contagem={
                        buscando
                          ? `(${lembretesFiltrados.length} de ${radar.lembretes_hoje.length})`
                          : `(${radar.lembretes_hoje.length})`
                      }
                      aberta={!fechadas.includes('lembretes_hoje')}
                      onAlternar={() => alternarSecao('lembretes_hoje')}
                      icone={
                        <CalendarClock className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                      }
                    />

                    {!fechadas.includes('lembretes_hoje') &&
                      (lembretesFiltrados.length === 0 ? (
                        buscaSemResultado ? null : (
                          <p className="text-sm text-muted-foreground">
                            Nenhum resultado nesta seção.
                          </p>
                        )
                      ) : (
                        <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {lembretesFiltrados.map((lembrete) => (
                            <CardLembrete
                              key={lembrete.lembrete_id}
                              lembrete={lembrete}
                              onAbrir={(leadId) => router.push(`/chat/${leadId}`)}
                            />
                          ))}
                        </div>
                      ))}
                  </section>
                )}

                {!isLoading && grupos.length > 0 && (
                  <BlocoDinheiro
                    grupos={grupos}
                    etapaAtiva={etapaAtiva}
                    onSelecionar={(etapa) =>
                      setEtapaFiltro((atual) => (atual === etapa ? null : etapa))
                    }
                  />
                )}

                {/* Backend anterior a Fase 2 devolve `melhores` vazia: a seção
                    inteira some em vez de mostrar um vazio sem explicacao. */}
                {!isLoading && radar.melhores.length > 0 && (
                  <section className="space-y-3">
                    <CabecalhoSecao
                      titulo="Foco do dia"
                      descricao={FOCO_DESCRICAO}
                      ajuda={AJUDA_FOCO}
                      contagem={
                        buscando
                          ? `(${filtradas.melhores.length} de ${radar.melhores.length})`
                          : `(${radar.melhores.length})`
                      }
                      aberta={!fechadas.includes('melhores')}
                      onAlternar={() => alternarSecao('melhores')}
                      icone={<Target className="h-4 w-4 text-muted-foreground" />}
                    />

                    {!fechadas.includes('melhores') &&
                      (filtradas.melhores.length === 0 ? (
                        buscaSemResultado ? null : (
                          <p className="text-sm text-muted-foreground">
                            Nenhum resultado nesta seção.
                          </p>
                        )
                      ) : (
                        <div className="grid items-start gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                          {filtradas.melhores.map((item) => (
                            <CardFoco
                              key={item.lead_id}
                              item={item}
                              onAbrir={(leadId) => router.push(`/chat/${leadId}`)}
                            />
                          ))}
                        </div>
                      ))}
                  </section>
                )}
              </Fragment>
            );
          })}

          {/* Pos-venda fecha a pagina: e consulta, nao pendencia do dia. */}
          {!isLoading && radar.compraram.length > 0 && (
            <section className="space-y-3">
              <CabecalhoSecao
                titulo="Compraram"
                descricao="Clientes que já fecharam — hora do pós-venda"
                ajuda={AJUDA_COMPRARAM}
                contagem={
                  buscando
                    ? `(${filtradas.compraram.length} de ${radar.compraram.length})`
                    : `(${radar.compraram.length})`
                }
                aberta={posVendaAberta}
                onAlternar={alternarPosVenda}
                icone={
                  <ShoppingBag className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                }
              />

              {posVendaAberta &&
                (filtradas.compraram.length === 0 ? (
                  buscaSemResultado ? null : (
                    <p className="text-sm text-muted-foreground">Nenhum resultado nesta seção.</p>
                  )
                ) : (
                  <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {filtradas.compraram.map((item) => (
                      <CardCompra
                        key={item.lead_id}
                        item={item}
                        expandido={expandidoId === chaveCard('compraram', item.lead_id)}
                        onAlternar={() =>
                          setExpandidoId((atual) => {
                            const alvo = chaveCard('compraram', item.lead_id);
                            return atual === alvo ? null : alvo;
                          })
                        }
                        onCopiar={copiar}
                        onAbrir={(leadId) => router.push(`/chat/${leadId}`)}
                      />
                    ))}
                  </div>
                ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
