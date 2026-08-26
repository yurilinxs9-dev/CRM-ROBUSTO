import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
// `Prisma` entra como VALOR (nao `type`): `Prisma.DbNull` e usado em tempo de execucao.
import { AiFeature, LeadTemperatura, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { buildVisibilityWhere } from '../leads/lead-visibility';
import { isWithinBroadcastWindow } from '../broadcasts/broadcast-window';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import type { AiChatMessage } from '../ai/ai.types';
import { LEAD_INSIGHTS_QUEUE, type GerarInsightJobData } from './lead-insights.queue';
import {
  extrairInsight,
  mesclarMemoria,
  montarPromptInsight,
  type CompraCitada,
  type InsightContexto,
  type InsightGerado,
  type MemoriaFato,
  type TemperaturaSugerida,
} from './insight-prompt';

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

/** Rajada de mensagens vira UM job: o gatilho espera 2min antes de rodar. */
const ATRASO_GATILHO_MS = 2 * MINUTO;
/** Sem novidade suficiente, so vale reprocessar se a ficha ja envelheceu. */
const WATERMARK_VELHO_MS = 12 * HORA;
const MSGS_PARA_DISPARAR = 5;
/** Contexto do modelo local e curto: 40 mensagens e o teto. */
const MSGS_CONTEXTO = 40;
const TENTATIVAS_JOB = 2;

const REFRESH_INTERVALO_MS = 5 * MINUTO;
/** Acima disso o Map de rate-limit e podado (processo longo, muitos leads). */
const REFRESH_MAP_MAX = 1000;

const CRON_LOTE = 50;
const CRON_ESPACAMENTO_MS = 30 * 1000;
const CRON_JANELA_ATIVIDADE_DIAS = 30;
const CRON_FICHA_VELHA_DIAS = 7;
/** Lead que nunca teve ficha so entra no cron com conversa de verdade. */
const CRON_MIN_MSGS_PRIMEIRA = 5;

/** Radar: teto por secao. Lista maior que isso ninguem trabalha num dia. */
const RADAR_CAP = 30;
/**
 * Quantas filas disputam o dedupe por precedencia — NAO e o numero de consultas
 * (sao 6). `melhores` e `compraram` ficam de fora do dedupe de proposito (ver
 * `radar()`), entao nao entram nesta conta e nao aumentam o `take`.
 */
const RADAR_FILAS = 4;
/**
 * Quantas linhas cada fila pede ao banco — NAO e o teto de cards, que continua
 * sendo `RADAR_CAP` no dedupe. Pedir 30 quebra as filas de baixo: as de cima
 * levam ate 30 ids cada uma, e a ultima pode perder 90 (3 x 30) para elas. Com
 * `take: 30` ela renderiza VAZIA tendo dezenas de leads elegiveis logo abaixo
 * do corte — e o `resumo` anunciaria "0 retornos hoje" com o banco cheio deles.
 * `RADAR_CAP * RADAR_FILAS` e o piso que garante 30 sobreviventes em qualquer
 * uma das filas.
 */
const RADAR_BUSCA = RADAR_CAP * RADAR_FILAS;
/** Lead quente parado a partir daqui ja e oportunidade esfriando na mao. */
const RADAR_PROMISSOR_DIAS = 2;
const RADAR_ESFRIANDO_DIAS = 7;
/**
 * "Esperando voce": ate onde o banco procura candidatos. Cliente que mandou
 * mensagem ha mais de 30 dias e nunca foi respondido nao e uma pendencia do
 * dia — e a mesma janela de atividade que o cron de fichas usa.
 */
const RADAR_ESPERANDO_JANELA_DIAS = 30;
/** Tipado pelo enum: rename no schema quebra aqui, nao em producao. */
const RADAR_TEMPERATURAS_QUENTES: LeadTemperatura[] = [
  LeadTemperatura.QUENTE,
  LeadTemperatura.MUITO_QUENTE,
];

/** "Foco do dia": quantos cards a secao mostra. Lista de trabalho, nao relatorio. */
const RADAR_FOCO = 10;
/**
 * Candidato ao foco do dia precisa de ficha: sem ela nao ha agenda nem nota
 * (dois dos cinco sinais do score seriam chute) e o card sairia mudo, sem
 * motivo e sem mensagem sugerida.
 *
 * Tipado como `Prisma.LeadWhereInput` e nao inline: o `where` do radar trafega
 * como `Record<string, unknown>`, entao `{ isNull: true }` (que nao existe)
 * passaria pelo compilador E pelos testes, com o Prisma mockado, e so quebraria
 * em producao.
 */
const RADAR_COM_FICHA: Prisma.LeadWhereInput = { lead_insight: { isNot: null } };
/** Ficha sem nota nao e ficha ruim: 5 e o meio da escala 0-10. */
const RADAR_NOTA_NEUTRA = 5;
/** Teto do sinal de valor: R$ 10.000 ja vale o maximo (ver `pontosValor`). */
const RADAR_VALOR_TETO_MIL = 10;

/*
 * ---------------------------------------------------------------------------
 * Score do "foco do dia" (fila `melhores`)
 * ---------------------------------------------------------------------------
 * Soma ponderada de 5 sinais, calculada NO APP: nao da para ordenar por isso no
 * Prisma (sao colunas de duas tabelas com faixas e tetos).
 *
 * A ponderacao privilegia de proposito os sinais AUTOMATICOS — a agenda que a
 * ficha do LLM escreveu e a atividade real da conversa. `temperatura` e campo
 * MANUAL: na pratica quase ninguem preenche, e existe tenant com 100% dos leads
 * em FRIO. Ancorar o ranking nela deixaria essas bases inteiras empatadas, ou
 * seja, sem foco nenhum — o oposto do que a secao existe para fazer.
 *
 * Faixa total: 0 (lead morto, sem ficha util) a ~16,5 (acao vencida, conversa de
 * ontem, negocio caro, atendimento nota 10 e muito quente).
 *
 * O score NAO vai no payload: e ranking interno. A UI mostra a ordem, nunca o
 * numero — nota de IA na tela e exatamente a "cara de IA" que o produto evita.
 */

/** Peso de cada temperatura. Manual, entao o peso do sinal e o menor (x1). */
const PESO_TEMPERATURA: Record<LeadTemperatura, number> = {
  [LeadTemperatura.FRIO]: 0,
  [LeadTemperatura.MORNO]: 1,
  [LeadTemperatura.QUENTE]: 2,
  [LeadTemperatura.MUITO_QUENTE]: 3,
};
const PESO_VALOR = 0.6;
const PESO_NOTA = 0.4;
/** Ate 48h (ou ja vencida) a acao e "para agora"; ate 7 dias, e a semana. */
const FOCO_ACAO_AGORA_DIAS = 2;
const FOCO_ACAO_SEMANA_DIAS = 7;
const FOCO_ACAO_AGORA_PONTOS = 3;
const FOCO_ACAO_SEMANA_PONTOS = 1;
const FOCO_RECENCIA_QUENTE_DIAS = 2;
const FOCO_RECENCIA_SEMANA_DIAS = 7;
const FOCO_RECENCIA_MES_DIAS = 30;
const FOCO_RECENCIA_QUENTE_PONTOS = 2.5;
const FOCO_RECENCIA_SEMANA_PONTOS = 1.5;
const FOCO_RECENCIA_MES_PONTOS = 0.5;

const TIMEZONE = 'America/Sao_Paulo';
/** Teto da busca pela proxima hora dentro da janela do tenant. */
const MAX_HORAS_BUSCA_JANELA = 7 * 24;

interface JanelaTenant {
  broadcast_window_start: number;
  broadcast_window_end: number;
  broadcast_window_days: number[];
}

/**
 * Empurra a data para a primeira hora que cai dentro da janela do tenant.
 * Sem isso, "proxima acao em 1 dia" numa sexta cairia no sabado e a tarefa
 * apareceria para o vendedor num dia em que ninguem trabalha.
 * Se em 7 dias de busca nada couber (janela mal configurada), devolve a data
 * crua — melhor uma data fora da janela do que nenhuma.
 */
export function ajustarParaJanela(base: Date, janela: JanelaTenant): Date {
  const { broadcast_window_start: inicio, broadcast_window_end: fim, broadcast_window_days: dias } = janela;
  if (!Array.isArray(dias) || dias.length === 0) return base;
  let candidata = base;
  for (let i = 0; i <= MAX_HORAS_BUSCA_JANELA; i++) {
    if (isWithinBroadcastWindow(candidata, TIMEZONE, inicio, fim, dias)) return candidata;
    candidata = new Date(candidata.getTime() + HORA);
  }
  return base;
}

/** Estreita `unknown` sem cast: objeto simples (nao array, nao null). */
function ehRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Json do banco -> compra tipada. Ficha antiga, string solta ou objeto sem
 * descricao viram `null`: melhor ficha sem compra do que compra quebrada na tela.
 */
export function lerCompra(valor: unknown): CompraCitada | null {
  if (!ehRegistro(valor)) return null;
  if (typeof valor.descricao !== 'string' || valor.descricao.trim() === '') return null;
  return {
    descricao: valor.descricao,
    valor: typeof valor.valor === 'number' && Number.isFinite(valor.valor) ? valor.valor : null,
    quando: typeof valor.quando === 'string' ? valor.quando : '',
  };
}

/**
 * Reais com centavos: o modelo devolve float longo (1234.5678) e o banco guarda
 * 2 casas. O sanitizador so garante que o valor e finito — 1e308 passa por ele e
 * vira `Infinity` no `* 100`, que a coluna nao aceita. Valor assim nao e preco:
 * melhor compra sem valor do que a gravacao inteira falhando.
 */
function arredondarValor(valor: number | null): number | null {
  if (valor === null) return null;
  const arredondado = Math.round(valor * 100) / 100;
  return Number.isFinite(arredondado) ? arredondado : null;
}

/**
 * O que gravar em `ultima_compra`. A compra e HISTORICO: o cliente cita uma vez
 * e as geracoes seguintes devolvem `null` — gravar esse null apagaria o dado.
 * Por isso: compra nova substitui; sem compra nova, a anterior e regravada.
 * Sem nenhuma das duas, `Prisma.DbNull` (SQL NULL da coluna nullable) — `null`
 * cru nao e aceito pelo client e `Prisma.JsonNull` gravaria o literal JSON null.
 */
function compraParaPersistir(
  nova: CompraCitada | null,
  anteriorJson: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const compra = nova ?? lerCompra(anteriorJson);
  if (compra === null) return Prisma.DbNull;
  return {
    descricao: compra.descricao,
    valor: arredondarValor(compra.valor),
    quando: compra.quando,
  };
}

/**
 * Transicao de etapa que o atendente recusou. Quem ESCREVE em `etapa_recusas`
 * sao os endpoints de aceitar/recusar; o worker so le.
 */
interface EtapaRecusa {
  estagio_id: string;
  /** ISO de quando foi recusada. */
  em: string;
}

/** Janela em que uma etapa recusada nao volta a ser sugerida. */
const RECUSA_JANELA_MS = 7 * DIA;

/**
 * Por quanto tempo a recusa fica guardada. Bem maior que os 7 dias que ela
 * bloqueia: a lista e o historico do que o atendente ja dispensou, e podar
 * exatamente na janela apagaria o rastro no dia em que ele deixa de valer.
 */
const RECUSA_RETENCAO_MS = 30 * DIA;
/**
 * Teto de recusas guardadas por ficha. A coluna e Json na mesma linha da ficha:
 * sem teto, um lead que passa meses no funil carrega uma lista que so cresce e
 * viaja inteira em toda leitura da ficha.
 */
const RECUSAS_MAX = 10;

/**
 * Lista que vai para o banco depois de mais uma recusa: poda o que venceu,
 * acrescenta a nova no fim (a lista e cronologica) e corta pelas mais recentes.
 *
 * Entrada com data ilegivel some aqui. `recusadaRecente` ja a ignora — ela nao
 * bloqueia nada e nunca venceria, entao guardar e so ocupar uma das 10 vagas.
 */
function proximasRecusas(atuais: EtapaRecusa[], estagioId: string, agora: number): EtapaRecusa[] {
  const vivas = atuais.filter((recusa) => {
    const em = new Date(recusa.em).getTime();
    return Number.isFinite(em) && agora - em < RECUSA_RETENCAO_MS;
  });
  vivas.push({ estagio_id: estagioId, em: new Date(agora).toISOString() });
  return vivas.slice(-RECUSAS_MAX);
}

/**
 * Json cru do banco -> recusas tipadas. A coluna nao tem validacao nenhuma no
 * banco (Json), entao entrada malformada e simplesmente ignorada — recusa
 * quebrada nao pode cegar a sugestao nem derrubar a geracao da ficha.
 */
export function lerRecusas(valor: unknown): EtapaRecusa[] {
  if (!Array.isArray(valor)) return [];
  const saida: EtapaRecusa[] = [];
  for (const item of valor) {
    if (!ehRegistro(item)) continue;
    if (typeof item.estagio_id !== 'string' || item.estagio_id.trim() === '') continue;
    if (typeof item.em !== 'string') continue;
    saida.push({ estagio_id: item.estagio_id, em: item.em });
  }
  return saida;
}

/** Mesma tecnica de `normalizarFato`: NFD sem acento, minusculo, aparado. */
function normalizarNome(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * O modelo devolve o NOME da etapa (e local, escreve "negociacao" sem acento e
 * em caixa baixa): so vira id se casar com uma etapa real do pipeline do lead.
 * Nome inventado = `null`, nunca FK quebrada no banco.
 */
export function resolverEtapaSugerida(
  sugerida: string | null,
  etapas: Array<{ id: string; nome: string }>,
  estagioAtualId: string,
): string | null {
  if (sugerida === null) return null;
  const alvo = normalizarNome(sugerida);
  if (alvo === '') return null;
  const etapa = etapas.find((e) => normalizarNome(e.nome) === alvo);
  if (etapa === undefined) return null;
  // Defesa em profundidade: a etapa atual ja fica de fora de `etapas_disponiveis`,
  // mas o modelo pode devolve-la assim mesmo — e "mover para onde ja esta" nao e
  // sugestao, e um card de sugestao inutil na tela do atendente.
  if (etapa.id === estagioAtualId) return null;
  return etapa.id;
}

/**
 * Etapa recusada nos ultimos 7 dias nao volta. Data ilegivel conta como NAO
 * recusada: melhor re-sugerir do que engolir a sugestao por lixo no Json.
 */
function recusadaRecente(recusas: EtapaRecusa[], estagioId: string, agora: number): boolean {
  return recusas.some((recusa) => {
    if (recusa.estagio_id !== estagioId) return false;
    const em = new Date(recusa.em).getTime();
    return Number.isFinite(em) && agora - em < RECUSA_JANELA_MS;
  });
}

/** Json do banco -> memoria tipada. Tolera lixo (ficha antiga, escrita a mao). */
export function lerMemoria(valor: unknown): MemoriaFato[] {
  if (!Array.isArray(valor)) return [];
  const saida: MemoriaFato[] = [];
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

/**
 * Contrato do Task 3: `null` = nao veio JSON utilizavel. Reforcado aqui com o
 * resumo em branco — um JSON valido de resumo vazio apagaria uma ficha boa,
 * que e exatamente o que nunca pode acontecer.
 */
function utilizavel(insight: InsightGerado | null): insight is InsightGerado {
  return insight !== null && insight.resumo.trim() !== '';
}

/**
 * O prompt e montado por LINHA: cabecalhos de secao ("## Conversa"), campos do
 * lead e turnos da conversa. Todo texto que o CLIENTE controla — o texto da
 * mensagem, mas tambem o pushName do WhatsApp que vira `nome`, e o telefone —
 * precisa entrar achatado, senao um `\n` cria uma linha nova e forja uma secao
 * ou um turno "[data] EQUIPE:" que o atendente nunca escreveu.
 */
function achatar(texto: string): string {
  return texto.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Card do radar: tudo que a UI precisa para agir sem abrir o lead. */
export interface RadarItem {
  lead_id: string;
  nome: string;
  telefone: string;
  etapa: string;
  temperatura: string;
  ultima_interacao: Date | null;
  motivo: string;
  msg_sugerida: string;
  proxima_acao_at: Date | null;
  /** Nome de quem responde pelo lead. `null` = lead sem dono (pool). */
  responsavel: string | null;
  /** Nomes das tags, achatados: a UI so pinta chip, nao navega relacao. */
  tags: string[];
  /**
   * ISO de quando o cliente mandou a mensagem que segue sem resposta. So a fila
   * `esperando_voce` preenche — nas outras secoes o dado nao significa nada
   * (o lead pode estar respondido) e viraria "esperando ha 3 dias" mentiroso.
   */
  esperando_desde: string | null;
  /** Decimal do Prisma nao serializa como numero: sai convertido daqui. */
  valor_estimado: number | null;
  /** Nota do atendimento (0-10) que a ficha deu. `null` = ficha sem nota. */
  nota_atendimento: number | null;
  /**
   * Compra que o cliente citou na conversa, como a ficha gravou. Vai em TODA
   * fila (o card e um so), mas so a secao "Compraram" a usa — nas outras a
   * informacao existe e simplesmente nao e desenhada.
   */
  compra: CompraCitada | null;
}

/** Os numeros do dia, para o header narrativo do radar. Zero query extra. */
export interface ResumoDia {
  esperando: number;
  chamar_hoje: number;
  /** Soma de `valor_estimado` dos cards de chamar_hoje. Sem valor conta 0. */
  valor_chamar_hoje: number;
  /** O retorno mais atrasado de hoje. `null` quando nao ha nenhum. */
  lembrete_destaque: { nome: string; motivo: string } | null;
}

export interface RadarResultado {
  resumo: ResumoDia;
  esperando_voce: RadarItem[];
  chamar_hoje: RadarItem[];
  promissores: RadarItem[];
  esfriando: RadarItem[];
  /**
   * "Foco do dia": os 10 melhores leads pelo score composto. Ranking
   * TRANSVERSAL — o mesmo lead pode (e costuma) aparecer tambem numa das filas
   * de trabalho acima. Nao e uma quinta caixa de tarefas.
   */
  melhores: RadarItem[];
  /** Pos-venda: quem fechou ou citou uma compra. Universo disjunto do resto. */
  compraram: RadarItem[];
}

const RADAR_SELECT = {
  id: true,
  nome: true,
  telefone: true,
  temperatura: true,
  ultima_interacao: true,
  // Vira `esperando_desde` na fila "esperando voce". A comparacao com
  // `last_agent_message_at` fica toda no banco (ver `filtroEsperando`), por isso
  // essa outra coluna nao precisa trafegar.
  last_customer_message_at: true,
  // Alimenta `resumo.valor_chamar_hoje` sem uma agregacao a mais no banco.
  valor_estimado: true,
  estagio: { select: { nome: true } },
  responsavel: { select: { nome: true } },
  // Ordem alfabetica: sem orderBy os chips trocam de lugar entre requisicoes.
  lead_tags: { select: { tag: { select: { nome: true } } }, orderBy: { tag: { nome: 'asc' } } },
  // Fonte legada de tag (ver `tagsDoLead`). Coluna da mesma linha: custo zero.
  tags: true,
  lead_insight: {
    select: {
      proxima_acao_at: true,
      proxima_acao_motivo: true,
      msg_sugerida: true,
      // Fase 2: `nota_atendimento` vira campo do card E entra no score do foco
      // do dia; `ultima_compra` e a compra em destaque no pos-venda.
      nota_atendimento: true,
      ultima_compra: true,
    },
  },
} as const;

type LinhaRadar = Prisma.LeadGetPayload<{ select: typeof RADAR_SELECT }>;

/**
 * O CRM tem DOIS estoques de tag e o radar precisa dos dois:
 * - a join `LeadTag -> Tag.nome`, que so a public API popula (e que espelha de
 *   volta no Json);
 * - a coluna Json `tags`, que e onde o app interno grava (tag-picker, PATCH, bulk).
 * Ler so a join deixaria quase todo lead do app interno sem chip nenhum.
 * A relacao ganha quando existe (tem id e cor); o Json e o fallback legado —
 * mesma precedencia da tabela de leads (`lead-table.tsx`).
 */
function tagsDoLead(relacao: { tag: { nome: string } }[], legado: Prisma.JsonValue): string[] {
  const daRelacao = relacao.map((lt) => lt.tag.nome);
  if (daRelacao.length > 0) return daRelacao;
  // Json cru: nada no banco impede numero, null, objeto ou string vazia no
  // meio da lista (mesma defesa de `lerCompra`/`lerMemoria`).
  if (!Array.isArray(legado)) return [];
  return legado.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

/** Dias inteiros parados. `null` = lead que nunca teve interacao registrada. */
function diasParado(ultima: Date | null, agora: number): number | null {
  if (ultima === null) return null;
  return Math.floor((agora - ultima.getTime()) / DIA);
}

/**
 * Motivo quando a ficha nao tem um (lead sem insight, ou insight sem motivo).
 * Sem acento, como o resto das mensagens do modulo.
 */
function motivoDerivado(dias: number | null, quente: boolean): string {
  const prefixo = quente ? 'QUENTE ' : '';
  if (dias === null) return `${prefixo}sem contato registrado`;
  return `${prefixo}sem contato ha ${dias} dia${dias === 1 ? '' : 's'}`;
}

/**
 * Acrescenta a condicao de uma secao ao `AND` do where base, sem apagar o que
 * ja estiver la. Hoje o `base` do radar nunca traz `AND` — mas o where trafega
 * como `Record<string, unknown>` e um spread `{ ...base, ...secao }` o
 * sobrescreveria em silencio no dia em que trouxer. E vai trazer: o precedente
 * e `mergeSearchCondition` (lead-visibility.ts), que mescla busca textual
 * justamente em `AND` para nao furar a visibilidade.
 *
 * O Prisma aceita `AND` como array ou como objeto unico; os dois casos entram.
 */
export function acrescentarAnd(
  base: Record<string, unknown>,
  condicao: Prisma.LeadWhereInput,
): Prisma.LeadWhereInput[] {
  const atual = base.AND;
  // Casts pontuais: `base` e Record<string, unknown> por causa do contrato de
  // `buildVisibilityWhere`, entao nao ha tipo a estreitar — so a forma.
  if (Array.isArray(atual)) return [...(atual as Prisma.LeadWhereInput[]), condicao];
  if (ehRegistro(atual)) return [atual as Prisma.LeadWhereInput, condicao];
  return [condicao];
}

function montarRadarItem(linha: LinhaRadar, agora: number, esperando: boolean): RadarItem {
  const quente = RADAR_TEMPERATURAS_QUENTES.includes(linha.temperatura);
  const motivoFicha = linha.lead_insight?.proxima_acao_motivo.trim() ?? '';
  return {
    lead_id: linha.id,
    nome: linha.nome,
    telefone: linha.telefone,
    etapa: linha.estagio?.nome ?? 'sem etapa',
    temperatura: String(linha.temperatura),
    ultima_interacao: linha.ultima_interacao,
    motivo:
      motivoFicha !== ''
        ? motivoFicha
        : motivoDerivado(diasParado(linha.ultima_interacao, agora), quente),
    msg_sugerida: linha.lead_insight?.msg_sugerida ?? '',
    proxima_acao_at: linha.lead_insight?.proxima_acao_at ?? null,
    responsavel: linha.responsavel?.nome ?? null,
    tags: tagsDoLead(linha.lead_tags, linha.tags),
    esperando_desde:
      esperando && linha.last_customer_message_at !== null
        ? linha.last_customer_message_at.toISOString()
        : null,
    valor_estimado: linha.valor_estimado?.toNumber() ?? null,
    nota_atendimento: linha.lead_insight?.nota_atendimento ?? null,
    // Json cru do banco: type guard, nunca cast (ficha antiga guarda string
    // solta e objeto sem descricao — um `as` deixaria isso chegar na tela).
    compra: lerCompra(linha.lead_insight?.ultima_compra),
  };
}

/**
 * Sinal da agenda: a ficha marcou uma acao que ja venceu ou vence nas proximas
 * 48h? Vencida pontua igual a de hoje — atraso nao torna o retorno menos
 * urgente, torna mais. Ficha sem agenda nao pontua (e nao e penalizada: os
 * outros 4 sinais seguem valendo).
 */
function pontosAgenda(proxima: Date | null, agora: number): number {
  if (proxima === null) return 0;
  const faltam = proxima.getTime() - agora;
  if (faltam <= FOCO_ACAO_AGORA_DIAS * DIA) return FOCO_ACAO_AGORA_PONTOS;
  if (faltam <= FOCO_ACAO_SEMANA_DIAS * DIA) return FOCO_ACAO_SEMANA_PONTOS;
  return 0;
}

/**
 * Sinal de atividade: conversa viva pontua mais. Em degraus (2 / 7 / 30 dias) e
 * nao continuo de proposito — o dado e ruidoso e degrau nao finge precisao.
 */
function pontosRecencia(ultima: Date | null, agora: number): number {
  if (ultima === null) return 0;
  const parado = agora - ultima.getTime();
  if (parado <= FOCO_RECENCIA_QUENTE_DIAS * DIA) return FOCO_RECENCIA_QUENTE_PONTOS;
  if (parado <= FOCO_RECENCIA_SEMANA_DIAS * DIA) return FOCO_RECENCIA_SEMANA_PONTOS;
  if (parado <= FOCO_RECENCIA_MES_DIAS * DIA) return FOCO_RECENCIA_MES_PONTOS;
  return 0;
}

/**
 * Sinal de valor, com TETO: R$ 10.000 ja vale o maximo. Sem o teto, um negocio
 * de R$ 1 milhao pontuaria 600 e a secao viraria um ranking so de valor — que e
 * o que o kanban ja faz. Negativo (digitacao errada) conta como zero.
 */
function pontosValor(valor: Prisma.Decimal | null): number {
  const reais = Math.max(valor?.toNumber() ?? 0, 0);
  return Math.min(reais / 1000, RADAR_VALOR_TETO_MIL) * PESO_VALOR;
}

/** O score composto do foco do dia. Ver o bloco de comentario dos pesos. */
function scoreFoco(linha: LinhaRadar, agora: number): number {
  return (
    pontosAgenda(linha.lead_insight?.proxima_acao_at ?? null, agora) +
    pontosRecencia(linha.ultima_interacao, agora) +
    pontosValor(linha.valor_estimado) +
    (linha.lead_insight?.nota_atendimento ?? RADAR_NOTA_NEUTRA) * PESO_NOTA +
    // Sem `?? 0`: se o enum ganhar uma temperatura nova, o compilador cobra o
    // peso dela aqui em vez de trata-la como zero em silencio.
    PESO_TEMPERATURA[linha.temperatura]
  );
}

/**
 * Decimal do Prisma nao soma sozinho; lead sem valor conta zero. O arredondamento
 * no fim e obrigatorio: a coluna guarda 2 casas, mas somar em float devolve
 * 0.30000000000000004 para 0.10 + 0.20 — e esse numero chegaria cru na tela.
 */
function somarValor(linhas: LinhaRadar[]): number {
  const total = linhas.reduce((soma, l) => soma + (l.valor_estimado?.toNumber() ?? 0), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Ficha inteligente do lead: enfileira, gera pelo LLM e serve para a UI.
 * Toda geracao passa pela fila (regra 1 do projeto: nada de LLM sincrono no
 * caminho do webhook).
 */
@Injectable()
export class LeadInsightsService {
  private readonly logger = new Logger(LeadInsightsService.name);
  /** leadId -> timestamp do ultimo refresh manual (rate limit por lead). */
  private readonly ultimoRefresh = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(LEAD_INSIGHTS_QUEUE) private readonly queue: Queue<GerarInsightJobData>,
    private readonly ai: AiProviderService,
    private readonly leads: LeadsService,
    private readonly gateway: CrmGateway,
  ) {}

  /**
   * Chamado pelo inbound a cada mensagem do cliente. So enfileira quando
   * ha novidade que justifique gastar o modelo: >=5 mensagens novas desde a
   * ultima geracao, OU >=1 se a ficha ja passou de 12h.
   */
  async enfileirarSeElegivel(leadId: string, tenantId: string): Promise<boolean> {
    const anterior = await this.prisma.leadInsight.findUnique({
      where: { lead_id: leadId },
      select: { ultima_msg_processada_at: true },
    });
    const watermark = anterior?.ultima_msg_processada_at ?? null;

    // Nota interna e a equipe falando com ela mesma: nao e novidade do cliente
    // e nao pode disparar (nem gastar) uma geracao do modelo.
    const novas = await this.prisma.message.count({
      where: {
        lead_id: leadId,
        is_internal_note: false,
        created_at: { gt: watermark ?? new Date(0) },
      },
    });
    if (novas === 0) return false;

    const fichaVelha = watermark === null || Date.now() - watermark.getTime() > WATERMARK_VELHO_MS;
    if (novas < MSGS_PARA_DISPARAR && !fichaVelha) return false;

    await this.enfileirar(leadId, tenantId, `lead-${leadId}`, ATRASO_GATILHO_MS);
    return true;
  }

  private async enfileirar(
    leadId: string,
    tenantId: string,
    jobId: string,
    delay: number,
  ): Promise<void> {
    await this.queue.add(
      'gerar',
      { leadId, tenantId },
      { jobId, delay, attempts: TENTATIVAS_JOB },
    );
  }

  /**
   * Ficha do lead para a UI. O acesso e o MESMO do detalhe do lead.
   * `include` (e nao `select`): a linha inteira continua indo para a tela, mais
   * o NOME da etapa sugerida — a ficha so guarda o id, e sem a relacao o card
   * da sugestao nao teria como escrever "Mover para Negociacao".
   */
  async obter(leadId: string, user: AuthUser) {
    await this.leads.findOne(leadId, user);
    return this.prisma.leadInsight.findUnique({
      where: { lead_id: leadId },
      include: { etapa_sugerida: { select: { nome: true } } },
    });
  }

  /**
   * Ficha com sugestao de etapa pendente, ou 404. Duas causas, mesma resposta:
   * lead que o usuario nao pode ver (quem decide e o LeadsService, exatamente
   * como no `refrescar`) e ficha sem nada a decidir — o segundo caso e a corrida
   * real de duas abas abertas, em que a outra ja aceitou ou recusou.
   */
  private async fichaComSugestao(
    leadId: string,
    user: AuthUser,
  ): Promise<{ etapa_sugerida_id: string; etapa_recusas: unknown }> {
    await this.leads.findOne(leadId, user);

    const ficha = await this.prisma.leadInsight.findUnique({
      where: { lead_id: leadId },
      select: { etapa_sugerida_id: true, etapa_recusas: true },
    });
    if (ficha === null || ficha.etapa_sugerida_id === null) {
      throw new NotFoundException('Esta ficha nao tem sugestao de etapa.');
    }
    return { etapa_sugerida_id: ficha.etapa_sugerida_id, etapa_recusas: ficha.etapa_recusas };
  }

  /**
   * Atendente aceitou a etapa sugerida: move o lead e apaga a sugestao.
   *
   * O move vai pelo `LeadsService.updateStage` de proposito — e a porta que
   * grava a atividade `stage_change` com o usuario que clicou, emite o WS e
   * invalida o cache do Kanban. Um `lead.update` cru aqui moveria o card em
   * silencio e o resto do CRM so descobriria no proximo refresh.
   *
   * `etapa_recusas` NAO e tocada: aceitar nao e recusar, e gravar a recusa aqui
   * vetaria por 7 dias justamente a etapa que o atendente acabou de aprovar.
   */
  async aceitarEtapaSugerida(leadId: string, user: AuthUser): Promise<{ ok: true }> {
    const ficha = await this.fichaComSugestao(leadId, user);

    await this.leads.updateStage(leadId, { estagio_id: ficha.etapa_sugerida_id }, user);

    // Sem transacao, e com o erro engolido: o lead JA mudou de etapa. Devolver
    // 500 daqui faria o atendente clicar de novo no card que a tela ainda
    // mostra — e mover o lead uma segunda vez. A sugestao velha, no pior caso,
    // some sozinha na proxima geracao da ficha.
    try {
      await this.prisma.leadInsight.update({
        where: { lead_id: leadId },
        data: { etapa_sugerida_id: null, etapa_sugerida_motivo: '' },
      });
    } catch (err) {
      this.logger.warn(
        `Etapa sugerida do lead ${leadId} foi aceita (lead movido), mas a ficha nao foi limpa: ${String(err)}`,
      );
    }

    return { ok: true };
  }

  /**
   * Atendente dispensou a sugestao: nada acontece com o lead, so a ficha muda.
   * A recusa fica registrada para o worker nao re-sugerir a mesma etapa nos
   * proximos 7 dias (`recusadaRecente`).
   */
  async recusarEtapaSugerida(leadId: string, user: AuthUser): Promise<{ ok: true }> {
    const ficha = await this.fichaComSugestao(leadId, user);

    const recusas = proximasRecusas(
      lerRecusas(ficha.etapa_recusas),
      ficha.etapa_sugerida_id,
      Date.now(),
    );

    await this.prisma.leadInsight.update({
      where: { lead_id: leadId },
      data: {
        etapa_recusas: recusas as unknown as Prisma.InputJsonValue,
        etapa_sugerida_id: null,
        etapa_sugerida_motivo: '',
      },
    });

    return { ok: true };
  }

  /** Regeracao manual. Rate limit por lead: 1 a cada 5 minutos. */
  async refrescar(leadId: string, user: AuthUser): Promise<{ ok: true; enfileirado: boolean }> {
    await this.leads.findOne(leadId, user);

    const agora = Date.now();
    const ultimo = this.ultimoRefresh.get(leadId);
    if (ultimo !== undefined && agora - ultimo < REFRESH_INTERVALO_MS) {
      throw new HttpException(
        'Ficha atualizada ha pouco. Tente novamente em alguns minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // jobId proprio: um gatilho automatico ja agendado (delay de 2min) nao pode
    // engolir o pedido manual, que precisa rodar agora.
    // O relogio so e marcado DEPOIS do enfileiramento: se o Redis recusar, o
    // usuario nao fica 5 minutos travado por um clique que nao gerou nada.
    await this.enfileirar(leadId, user.tenantId, `refresh-${leadId}`, 0);
    this.podarRefresh(agora);
    this.ultimoRefresh.set(leadId, agora);
    return { ok: true, enfileirado: true };
  }

  /**
   * Radar comercial: a fila de trabalho do vendedor em 4 secoes, mais duas
   * leituras que NAO sao fila de tarefa.
   * - esperando_voce: o cliente falou por ultimo e ninguem respondeu.
   * - chamar_hoje: a ficha marcou uma proxima acao que ja venceu.
   * - promissores: lead quente que parou de conversar.
   * - esfriando: qualquer lead ativo parado ha uma semana.
   * - melhores: os 10 melhores do dia pelo score composto (ranking transversal
   *   sobre as MESMAS pessoas — fora do dedupe de proposito).
   * - compraram: pos-venda (etapa ganha ou compra citada) — universo disjunto,
   *   tambem fora do dedupe.
   * Nas 4 primeiras um lead aparece UMA vez so, na secao mais urgente
   * (esperando_voce > chamar_hoje > promissores > esfriando) — a mesma pessoa
   * em quatro listas seria trabalho repetido, e cliente sem resposta e sempre a
   * pendencia mais urgente que existe. Estagio ganho/perdido nunca entra:
   * negocio fechado ou morto nao e tarefa.
   * `pipelineId` opcional recorta TODAS as filas por funil (ausente = todos).
   */
  async radar(user: AuthUser, pipelineId?: string): Promise<RadarResultado> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { pool_enabled: true },
    });
    // O que TODA fila compartilha: tenant, funil e visibilidade. A etapa fica
    // de fora daqui porque a fila `compraram` precisa do oposto das outras
    // (etapa ganha) — sem essa separacao ela herdaria `is_won: false` e viria
    // sempre vazia.
    const baseComum: Record<string, unknown> = { tenant_id: user.tenantId };
    // Chave disjunta da visibilidade (que so escreve `OR`/`responsavel_id`):
    // o funil recorta todas as filas sem nunca comer o recorte de quem ve o que.
    if (pipelineId !== undefined) baseComum.pipeline_id = pipelineId;
    Object.assign(
      baseComum,
      buildVisibilityWhere({
        userId: user.id,
        role: user.role as UserRole,
        poolEnabled: Boolean(tenant?.pool_enabled),
      }),
    );
    // Base das filas de trabalho: negocio fechado ou morto nao e tarefa.
    const base: Record<string, unknown> = {
      ...baseComum,
      estagio: { is_won: false, is_lost: false },
    };

    const agora = Date.now();
    const [vencidos, quentes, parados, esperandoAgora, candidatosFoco, clientes] = await Promise.all([
      this.buscarRadar(
        { ...base, lead_insight: { proxima_acao_at: { lte: new Date(agora) } } },
        // Mais atrasado primeiro: a acao vencida ha mais tempo e a mais urgente.
        { lead_insight: { proxima_acao_at: 'asc' } },
      ),
      this.buscarRadar(
        {
          ...base,
          temperatura: { in: RADAR_TEMPERATURAS_QUENTES },
          ultima_interacao: { lte: new Date(agora - RADAR_PROMISSOR_DIAS * DIA) },
        },
        { ultima_interacao: 'asc' },
      ),
      this.buscarRadar(
        { ...base, ultima_interacao: { lte: new Date(agora - RADAR_ESFRIANDO_DIAS * DIA) } },
        { ultima_interacao: 'asc' },
      ),
      this.buscarRadar(
        { ...base, ...this.filtroEsperando(agora, base) },
        // Quem espera ha mais tempo primeiro.
        { last_customer_message_at: 'asc' },
      ),
      // Foco do dia: candidatos com ficha. Quem ordena e o `scoreFoco` no app —
      // o banco so entrega um lote grande, e do mais recente para o mais antigo
      // (se o lote precisar cortar, corta pelo lead mais parado).
      this.buscarRadar({ ...base, ...RADAR_COM_FICHA }, { ultima_interacao: 'desc' }),
      // Pos-venda: do contato mais recente para o mais antigo — ao contrario
      // das filas de trabalho, onde o mais parado e o mais urgente.
      this.buscarRadar(this.filtroCompraram(baseComum), { ultima_interacao: 'desc' }),
    ]);

    // Dedupe por precedencia: cada lead vira card UMA vez, na fila mais urgente
    // em que aparece. Quem ja foi servido por uma fila anterior e pulado aqui,
    // e o corte em `RADAR_CAP` e o teto de cards por secao — as consultas
    // trazem `RADAR_BUSCA` justamente para sobrar linha depois deste roubo.
    const vistos = new Set<string>();
    const selecionar = (linhas: LinhaRadar[]): LinhaRadar[] => {
      const saida: LinhaRadar[] = [];
      for (const linha of linhas) {
        if (saida.length >= RADAR_CAP) break;
        if (vistos.has(linha.id)) continue;
        vistos.add(linha.id);
        saida.push(linha);
      }
      return saida;
    };

    // Ordem das chamadas = precedencia do dedupe, nao a ordem das queries.
    const linhasEsperando = selecionar(esperandoAgora);
    const linhasChamarHoje = selecionar(vencidos);
    const linhasPromissores = selecionar(quentes);
    const linhasEsfriando = selecionar(parados);

    const esperando_voce = linhasEsperando.map((l) => montarRadarItem(l, agora, true));
    const chamar_hoje = linhasChamarHoje.map((l) => montarRadarItem(l, agora, false));

    // As duas filas da fase 2 NAO passam por `selecionar`: ficam fora do dedupe
    // de proposito. `melhores` e um ranking transversal (o mesmo lead aparece
    // aqui e na fila de trabalho dele — sao leituras diferentes das mesmas
    // pessoas) e `compraram` e um universo disjunto (etapa ganha). Se
    // participassem, alem de perder cards elas roubariam leads das filas da
    // fase 1, que rodam depois no dedupe.
    const melhores = candidatosFoco
      .map((linha) => ({ linha, score: scoreFoco(linha, agora) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, RADAR_FOCO)
      // O score morre aqui: e ranking interno, nao dado de tela.
      .map(({ linha }) => montarRadarItem(linha, agora, false));

    return {
      // Contado do que a UI de fato recebe (pos-dedupe, pos-cap), nunca do que
      // o banco devolveu: numero do header que nao bate com a lista abaixo dele
      // e pior do que nao ter header.
      resumo: {
        esperando: esperando_voce.length,
        chamar_hoje: chamar_hoje.length,
        valor_chamar_hoje: somarValor(linhasChamarHoje),
        // O mais atrasado da fila e o lembrete que o vendedor precisa ver.
        lembrete_destaque:
          chamar_hoje.length > 0
            ? { nome: chamar_hoje[0].nome, motivo: chamar_hoje[0].motivo }
            : null,
      },
      esperando_voce,
      chamar_hoje,
      promissores: linhasPromissores.map((l) => montarRadarItem(l, agora, false)),
      esfriando: linhasEsfriando.map((l) => montarRadarItem(l, agora, false)),
      melhores,
      compraram: clientes.slice(0, RADAR_CAP).map((l) => montarRadarItem(l, agora, false)),
    };
  }

  /**
   * Recorte da fila "compraram" (pos-venda), inteiro no BANCO pelo mesmo motivo
   * da fila esperando_voce: filtrar depois, sobre um lote com `take`, deixaria a
   * secao vazia com clientes de verdade no banco.
   *
   * Duas portas de entrada, porque as duas existem na base real: o lead que a
   * equipe moveu para uma etapa ganha, e o lead que CONTOU na conversa que
   * comprou (a ficha do LLM grava isso em `ultima_compra`) sem nunca ter sido
   * movido de etapa — sao centenas, e sem a segunda porta ficariam invisiveis.
   *
   * Perdido continua fora: negocio morto nao e pos-venda. Ganho, ao contrario
   * das outras filas, e justamente o que se procura aqui — por isso esta fila
   * parte de `baseComum` e nao da `base` das filas de trabalho.
   *
   * O `OR` vai aninhado em `AND` (via `acrescentarAnd`) pela mesma razao da
   * fila esperando_voce: escrito no topo, comeria em silencio o `OR` da
   * visibilidade e vazaria lead de outro operador com a suite verde.
   */
  private filtroCompraram(baseComum: Record<string, unknown>): Record<string, unknown> {
    return {
      ...baseComum,
      estagio: { is_lost: false },
      AND: acrescentarAnd(baseComum, {
        OR: [
          { estagio: { is_won: true } },
          // Coluna Json nullable: `Prisma.DbNull` e a forma que o client aceita
          // para "SQL NULL" — `null` cru nao compila aqui.
          { lead_insight: { ultima_compra: { not: Prisma.DbNull } } },
        ],
      }),
    };
  }

  /**
   * Recorte da fila "esperando voce", inteiro no BANCO: o cliente mandou
   * mensagem recente e a equipe ainda nao respondeu.
   *
   * "Ainda nao respondeu" compara COLUNA COM COLUNA, e isso se resolve com
   * field reference do Prisma (`prisma.lead.fields.*`, disponivel desde a 4.5).
   * A alternativa que parece obvia — buscar um lote e filtrar em memoria — e
   * furada e nao apenas lenta: o lote vem ordenado por quem espera ha mais
   * tempo, ou seja, pelos candidatos com MAIS chance de ja terem sido
   * respondidos. Num tenant com movimento normal o lote inteiro seria descartado
   * e a fila apareceria vazia com clientes esperando de verdade no banco.
   *
   * O `OR` da secao vai aninhado dentro de `AND` de proposito: escrito no topo,
   * ele sobrescreveria em silencio o `OR` de visibilidade que
   * `buildVisibilityWhere` espalha no `base` — vazando lead de outro operador
   * com a suite verde. E o `AND` e composto por `acrescentarAnd`, nao escrito
   * por cima, para que a proxima condicao que chegar ao `base` (busca textual,
   * por exemplo) nao caia no mesmo buraco na outra direcao.
   *
   * `last_agent_message_at: null` precisa estar explicito: em SQL,
   * `null < data` e null, nao verdadeiro — sem esse ramo, o lead que a equipe
   * NUNCA respondeu (o mais urgente que existe) ficaria de fora.
   *
   * Empate no milissegundo conta como respondido (`lt`, nao `lte`): fila de
   * trabalho erra melhor para menos do que cobrando retorno ja dado.
   *
   * Tipado como `Prisma.LeadWhereInput`, e nao inline no `findMany`: o `where`
   * do radar trafega como `Record<string, unknown>`, entao um nome de coluna
   * errado passaria pelo compilador E pelos testes (o Prisma e mockado) e so
   * quebraria em producao. Aqui o compilador confere coluna e formato.
   */
  private filtroEsperando(agora: number, base: Record<string, unknown>): Prisma.LeadWhereInput {
    return {
      last_customer_message_at: {
        not: null,
        gte: new Date(agora - RADAR_ESPERANDO_JANELA_DIAS * DIA),
      },
      AND: acrescentarAnd(base, {
        OR: [
          { last_agent_message_at: null },
          { last_agent_message_at: { lt: this.prisma.lead.fields.last_customer_message_at } },
        ],
      }),
    };
  }

  private buscarRadar(
    where: Record<string, unknown>,
    orderBy: Prisma.LeadOrderByWithRelationInput,
  ): Promise<LinhaRadar[]> {
    return this.prisma.lead.findMany({ where, select: RADAR_SELECT, orderBy, take: RADAR_BUSCA });
  }

  private podarRefresh(agora: number): void {
    if (this.ultimoRefresh.size < REFRESH_MAP_MAX) return;
    for (const [lead, quando] of this.ultimoRefresh) {
      if (agora - quando >= REFRESH_INTERVALO_MS) this.ultimoRefresh.delete(lead);
    }
  }

  /**
   * Worker: monta o contexto, chama o modelo e grava a ficha.
   * Nunca lanca por resposta ruim do modelo — job com falha ficaria em retry
   * infinito por causa de um 3B teimoso. Falha de parse = mantem a ficha atual.
   */
  async gerarInsight(leadId: string, tenantId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      select: {
        id: true,
        nome: true,
        telefone: true,
        temperatura: true,
        valor_estimado: true,
        ultima_interacao: true,
        // Fase 4: a etapa atual sai da lista oferecida ao modelo e o pipeline
        // define quais etapas existem para sugerir.
        estagio_id: true,
        pipeline_id: true,
        estagio: { select: { nome: true } },
        tenant: {
          select: {
            broadcast_window_start: true,
            broadcast_window_end: true,
            broadcast_window_days: true,
            // Toggle do tenant: sem ele a sugestao de temperatura so e exibida.
            ia_ajusta_temperatura: true,
          },
        },
      },
    });
    if (!lead) {
      this.logger.warn(`Insight ignorado: lead ${leadId} nao existe no tenant ${tenantId}`);
      return;
    }

    const recentes = await this.prisma.message.findMany({
      where: { lead_id: leadId, is_internal_note: false },
      orderBy: { created_at: 'desc' },
      take: MSGS_CONTEXTO,
      select: { direction: true, type: true, content: true, created_at: true },
    });
    if (recentes.length === 0) return;
    const mensagens = [...recentes].reverse();

    const anterior = await this.prisma.leadInsight.findUnique({
      where: { lead_id: leadId },
      // `ultima_compra` entra no select porque a ficha anterior e a fonte quando o
      // modelo nao cita compra nenhuma nesta geracao. `etapa_recusas` e so LEITURA
      // aqui: quem escreve nela sao os endpoints de aceitar/recusar a sugestao.
      select: { resumo: true, memoria: true, ultima_compra: true, etapa_recusas: true },
    });

    // Etapas do pipeline DO LEAD. Ganha/perdida entram de proposito: sugerir
    // fechamento e uma leitura valida da conversa — mover continua sendo humano.
    const etapas = await this.prisma.stage.findMany({
      where: { pipeline_id: lead.pipeline_id, tenant_id: tenantId },
      select: { id: true, nome: true },
      orderBy: { ordem: 'asc' },
    });

    const contexto: InsightContexto = {
      lead: {
        nome: achatar(lead.nome),
        telefone: achatar(lead.telefone),
        etapa: lead.estagio?.nome ?? 'sem etapa',
        temperatura: String(lead.temperatura),
        // Decimal do Prisma nao serializa como numero sozinho.
        valor_estimado: lead.valor_estimado === null ? null : lead.valor_estimado.toNumber(),
        ultima_interacao: lead.ultima_interacao,
        // A etapa atual fica de fora: oferecer a etapa em que o lead ja esta so
        // convidaria o modelo a "sugerir" o que nao muda nada.
        etapas_disponiveis: etapas.filter((e) => e.id !== lead.estagio_id).map((e) => e.nome),
      },
      insightAnterior: anterior
        ? { resumo: anterior.resumo, memoria: lerMemoria(anterior.memoria) }
        : null,
      mensagens: mensagens.map((m) => ({
        de: m.direction === 'INCOMING' ? ('cliente' as const) : ('equipe' as const),
        texto: achatar(m.content ?? `[${String(m.type)}]`),
        em: m.created_at,
      })),
    };

    const prompt = montarPromptInsight(contexto);
    let insight = await this.pedirInsight(prompt, tenantId, leadId);
    if (!utilizavel(insight)) {
      const reforco: AiChatMessage[] = [
        ...prompt,
        { role: 'user', content: 'Responda SOMENTE o objeto JSON.' },
      ];
      insight = await this.pedirInsight(reforco, tenantId, leadId);
    }
    if (!utilizavel(insight)) {
      this.logger.warn(
        `Insight do lead ${leadId}: modelo nao devolveu JSON utilizavel em 2 tentativas — ficha anterior mantida`,
      );
      return;
    }

    const memoria = mesclarMemoria(
      anterior ? lerMemoria(anterior.memoria) : [],
      insight.memoria_novos_fatos,
    );
    const proximaAcao = ajustarParaJanela(
      new Date(Date.now() + insight.proxima_acao_em_dias * DIA),
      lead.tenant,
    );
    const watermark = mensagens[mensagens.length - 1].created_at;

    // Sugerir a temperatura que o lead JA tem nao e sugestao: vira card mudo na
    // ficha e, com o toggle ligado, um update que nao muda nada.
    const temperaturaAtual = String(lead.temperatura);
    const temperaturaSugerida: TemperaturaSugerida | null =
      insight.temperatura_sugerida !== null && insight.temperatura_sugerida !== temperaturaAtual
        ? insight.temperatura_sugerida
        : null;

    const etapaResolvida = resolverEtapaSugerida(insight.etapa_sugerida, etapas, lead.estagio_id);
    const etapaSugeridaId =
      etapaResolvida !== null &&
      !recusadaRecente(lerRecusas(anterior?.etapa_recusas), etapaResolvida, Date.now())
        ? etapaResolvida
        : null;

    const campos = {
      resumo: insight.resumo,
      memoria: memoria as unknown as Prisma.InputJsonValue,
      proxima_acao_at: proximaAcao,
      proxima_acao_motivo: insight.proxima_acao_motivo,
      msg_sugerida: insight.msg_sugerida,
      nota_atendimento: insight.nota_atendimento,
      nota_ponto_forte: insight.nota_ponto_forte,
      nota_ponto_melhoria: insight.nota_ponto_melhoria,
      ultima_compra: compraParaPersistir(insight.ultima_compra, anterior?.ultima_compra),
      // Sugestao SEMPRE gravada (com toggle ligado ou nao): a ficha e o que a
      // tela mostra. Sem sugestao valida vai null/"" — geracao nova limpa a
      // sugestao velha, senao o atendente veria um card de dias atras.
      temperatura_sugerida: temperaturaSugerida,
      temperatura_justificativa:
        temperaturaSugerida === null ? '' : insight.temperatura_justificativa,
      etapa_sugerida_id: etapaSugeridaId,
      etapa_sugerida_motivo: etapaSugeridaId === null ? '' : insight.etapa_sugerida_motivo,
      ultima_msg_processada_at: watermark,
    };

    // Upsert pelo client (nao SQL cru): `updated_at` nao tem default no banco,
    // quem preenche e o Prisma.
    await this.prisma.leadInsight.upsert({
      where: { lead_id: leadId },
      create: { tenant_id: tenantId, lead_id: leadId, ...campos, geracoes: 1 },
      update: { ...campos, geracoes: { increment: 1 } },
    });

    // Depois do upsert e de proposito: a ficha vale mais que o ajuste. Se a
    // aplicacao falhar, a sugestao ja esta gravada e o atendente a ve na tela.
    if (temperaturaSugerida !== null && lead.tenant.ia_ajusta_temperatura) {
      await this.aplicarTemperatura(
        leadId,
        tenantId,
        temperaturaAtual,
        temperaturaSugerida,
        insight.temperatura_justificativa,
      );
    }

    await this.rechecarNovidade(leadId, tenantId, watermark);
  }

  /**
   * Aplica no lead a temperatura que a ficha sugeriu (toggle `ia_ajusta_temperatura`).
   * Nunca lanca: um deadlock no update nao pode derrubar o job — a ficha ja foi
   * gravada e a sugestao continua visivel.
   * A activity vai com `user_id: null` porque quem mudou foi a IA, nao uma pessoa.
   */
  private async aplicarTemperatura(
    leadId: string,
    tenantId: string,
    atual: string,
    nova: TemperaturaSugerida,
    justificativa: string,
  ): Promise<void> {
    try {
      await this.prisma.lead.update({ where: { id: leadId }, data: { temperatura: nova } });
      const motivo = justificativa.trim();
      await this.prisma.leadActivity.create({
        data: {
          lead_id: leadId,
          user_id: null,
          tipo: 'ia_temperatura',
          descricao: `IA: ${atual} → ${nova}${motivo === '' ? '' : ` — ${motivo}`}`,
          dados_antes: { temperatura: atual },
          dados_depois: { temperatura: nova },
          tenant_id: tenantId,
        },
      });
      // Regra 8 do projeto: mutacao de lead sempre emite para o Kanban/Chat.
      this.gateway.emitLeadUpdated(leadId, { temperatura: nova }, tenantId);
    } catch (err) {
      this.logger.warn(
        `Temperatura sugerida do lead ${leadId} nao foi aplicada (ficha gravada): ${String(err)}`,
      );
    }
  }

  /**
   * Mensagem que chegou ENQUANTO este job rodava (o modelo local leva de 30s a
   * 2min) perde o gatilho: o `queue.add` do inbound e descartado porque o jobId
   * `lead-<id>` ainda existe — o job esta ACTIVE, nao so delayed. Sem esta
   * reconferencia pos-upsert, a ultima mensagem do cliente ficaria fora da ficha
   * ate a proxima mensagem ou ate o cron de 7 dias.
   */
  private async rechecarNovidade(
    leadId: string,
    tenantId: string,
    watermark: Date,
  ): Promise<void> {
    try {
      // Mesmo recorte do gatilho: nota interna nao conta como novidade.
      const pendentes = await this.prisma.message.count({
        where: { lead_id: leadId, is_internal_note: false, created_at: { gt: watermark } },
      });
      if (pendentes === 0) return;
      // jobId NAO pode ser `lead-<id>`: e o do job que esta rodando agora, e o
      // add cairia no mesmo buraco. O watermark deixa o id unico por geracao.
      await this.enfileirar(
        leadId,
        tenantId,
        `lead-${leadId}-${watermark.getTime()}`,
        ATRASO_GATILHO_MS,
      );
      this.logger.log(
        `Insight do lead ${leadId}: ${pendentes} msg(s) chegaram durante a geracao — re-enfileirado`,
      );
    } catch (err) {
      this.logger.warn(`Recheque de novidade do lead ${leadId} falhou: ${String(err)}`);
    }
  }

  private async pedirInsight(
    messages: AiChatMessage[],
    tenantId: string,
    leadId: string,
  ): Promise<InsightGerado | null> {
    const resposta = await this.ai.chat({
      feature: AiFeature.insights,
      messages,
      tenantId,
      leadId,
      // 900 (era 700): a resposta agora tem 9 chaves — com nota, os dois pontos do
      // atendimento e a compra, 700 tokens cortavam o JSON no meio.
      opts: { temperature: 0.4, maxTokens: 900 },
    });
    return extrairInsight(resposta.text);
  }

  /**
   * Varredura diaria: leads vivos (mensagem nos ultimos 30 dias) cuja ficha
   * passou de 7 dias — ou que nunca tiveram ficha e ja tem conversa de verdade.
   * Os jobs saem espacados em 30s para nao entupir o modelo local de uma vez.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: TIMEZONE })
  async varrerLeadsParados(): Promise<number> {
    const agora = Date.now();
    const desdeAtividade = new Date(agora - CRON_JANELA_ATIVIDADE_DIAS * DIA);
    const fichaVelha = new Date(agora - CRON_FICHA_VELHA_DIAS * DIA);

    // O corte de ">=5 mensagens" nao existe como filtro no Prisma (nao ha where
    // por _count), entao busca-se um multiplo do lote e filtra-se em memoria.
    const candidatos = await this.prisma.lead.findMany({
      where: {
        messages: { some: { created_at: { gte: desdeAtividade } } },
        OR: [{ lead_insight: { is: null } }, { lead_insight: { updated_at: { lt: fichaVelha } } }],
      },
      select: {
        id: true,
        tenant_id: true,
        lead_insight: { select: { updated_at: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { ultima_interacao: 'desc' },
      take: CRON_LOTE * 4,
    });

    const elegiveis = candidatos
      .filter((l) => l.lead_insight !== null || l._count.messages >= CRON_MIN_MSGS_PRIMEIRA)
      .slice(0, CRON_LOTE);

    let enfileirados = 0;
    for (const [i, lead] of elegiveis.entries()) {
      try {
        await this.enfileirar(lead.id, lead.tenant_id, `lead-${lead.id}`, i * CRON_ESPACAMENTO_MS);
        enfileirados++;
      } catch (err) {
        this.logger.warn(`Cron de insights: falha ao enfileirar lead ${lead.id}: ${String(err)}`);
      }
    }
    if (enfileirados > 0) {
      this.logger.log(`Cron de insights: ${enfileirados} leads enfileirados para regeracao`);
    }
    return enfileirados;
  }
}
