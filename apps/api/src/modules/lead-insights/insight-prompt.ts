import type { AiChatMessage } from '../ai/ai.types';

/** Fato memorizado sobre o lead (dito pelo proprio cliente). */
export interface MemoriaFato {
  fato: string;
  quando_dito: string;
}

/** Contexto que o worker (Task 4) monta antes de chamar o modelo. */
export interface InsightContexto {
  lead: {
    nome: string | null;
    telefone: string | null;
    etapa: string;
    temperatura: string;
    valor_estimado: number | null;
    ultima_interacao: Date | null;
  };
  insightAnterior: { resumo: string; memoria: MemoriaFato[] } | null;
  /** Ja limitadas a 40 pelo chamador, em ordem cronologica. */
  mensagens: Array<{ de: 'cliente' | 'equipe'; texto: string; em: Date }>;
}

/** Compra que o PROPRIO CLIENTE citou na conversa (nunca inferida). */
export interface CompraCitada {
  descricao: string;
  valor: number | null;
  /** Como o cliente datou a compra ("mes passado", "2026-07"); vazio se nao disse. */
  quando: string;
}

/** Insight ja saneado, pronto para persistir. */
export interface InsightGerado {
  resumo: string;
  memoria_novos_fatos: MemoriaFato[];
  /** Sempre entre 1 e 30. */
  proxima_acao_em_dias: number;
  proxima_acao_motivo: string;
  msg_sugerida: string;
  /** Nota do ATENDENTE, inteiro de 0 a 10; null quando o modelo nao avaliou. */
  nota_atendimento: number | null;
  nota_ponto_forte: string;
  nota_ponto_melhoria: string;
  ultima_compra: CompraCitada | null;
}

const LIMITE_RESUMO = 800;
const LIMITE_MOTIVO = 200;
const LIMITE_MSG = 500;
const LIMITE_FATO = 200;
const LIMITE_QUANDO = 40;
const MAX_FATOS_NOVOS = 20;
const MAX_MEMORIA = 30;
const DIAS_MIN = 1;
const DIAS_MAX = 30;
const DIAS_DEFAULT = 7;
const LIMITE_PONTO = 200;
const LIMITE_COMPRA_DESCRICAO = 200;
const LIMITE_COMPRA_QUANDO = 60;
const NOTA_MIN = 0;
const NOTA_MAX = 10;
/** Cada mensagem entra no prompt truncada — modelo local tem contexto curto. */
const LIMITE_TEXTO_MENSAGEM = 1000;

const SHAPE_JSON = `{
  "resumo": "string",
  "memoria_novos_fatos": [{ "fato": "string", "quando_dito": "AAAA-MM-DD" }],
  "proxima_acao_em_dias": 3,
  "proxima_acao_motivo": "string",
  "msg_sugerida": "string",
  "nota_atendimento": 7,
  "nota_ponto_forte": "string",
  "nota_ponto_melhoria": "string",
  "ultima_compra": { "descricao": "string", "valor": 0, "quando": "string" }
}`;

const SYSTEM_PROMPT = `Voce e um assistente de analise comercial de um CRM de WhatsApp em portugues do Brasil.
Voce le a conversa entre a equipe de atendimento e o cliente e devolve uma ficha do lead.

Responda APENAS com o objeto JSON abaixo, sem texto antes ou depois, sem markdown, sem crase.
Use exatamente estas 9 chaves:
${SHAPE_JSON}

Regras de cada campo:
- "resumo": 2 a 4 frases sobre onde a negociacao parou, o que o cliente quer e o que ficou pendente.
- "memoria_novos_fatos": fatos pessoais ou comerciais ditos pelo PROPRIO CLIENTE (obra, familia, prazo, orcamento, viagem, saude). Nunca invente; se nao houver fato novo, devolva [].
- "proxima_acao_em_dias": inteiro de 1 a 30, quantos dias esperar ate o proximo contato, coerente com o ritmo da conversa (conversa quente = poucos dias; cliente pediu prazo longo = mais dias).
- "proxima_acao_motivo": uma frase curta dizendo por que voltar a falar nesse prazo.
- "msg_sugerida": mensagem curta, natural e educada que o ATENDENTE HUMANO poderia enviar, na primeira pessoa de quem atende. Sem "sou uma IA", sem se apresentar como robo, sem emoji em excesso.
- "nota_atendimento": inteiro de 0 a 10 avaliando o ATENDENTE (nao o cliente): rapidez das respostas, clareza das explicacoes e conducao da negociacao (perguntou o que faltava, ofereceu o proximo passo). Se a conversa nao tiver mensagens da equipe suficientes para avaliar, use null.
- "nota_ponto_forte": UMA linha dizendo o que o atendente fez bem.
- "nota_ponto_melhoria": UMA linha dizendo o que o atendente poderia melhorar.
- "ultima_compra": preencha APENAS se o CLIENTE citou na conversa uma compra ou fechamento ja feito ("comprei", "levei", "fechamos", "paguei"). "descricao" = o que ele disse ter comprado; "valor" = numero em reais somente se ele falou o valor, senao null; "quando" = como ele datou ("mes passado", "em julho"), senao "". Nunca invente compra, valor ou data: sem mencao explicita do cliente, use null no campo inteiro. Orcamento, cotacao ou intencao de compra NAO contam.

Restricoes absolutas:
- Voce NUNCA responde pelo cliente e NUNCA envia nada: apenas sugere para o atendente humano decidir.
- Nao invente dados que nao estao na conversa.
- Nao escreva nada fora do objeto JSON.`;

/** Corta preservando pares substitutos (unicode) para nao gerar caractere quebrado. */
function truncar(texto: string, limite: number): string {
  if (texto.length <= limite) return texto;
  const cortado = texto.slice(0, limite);
  const ultimo = cortado.charCodeAt(limite - 1);
  // Se o corte deixou um high surrogate solto, remove-o.
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) return cortado.slice(0, limite - 1);
  return cortado;
}

function comoTexto(valor: unknown, limite: number): string {
  if (typeof valor !== 'string') return '';
  return truncar(valor.trim(), limite);
}

/** Numero solto (aceita string numerica que o modelo local costuma devolver). */
function comoNumero(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  if (typeof valor === 'string' && valor.trim() !== '' && Number.isFinite(Number(valor))) return Number(valor);
  return null;
}

function comoDias(valor: unknown): number {
  const n = comoNumero(valor);
  if (n === null) return DIAS_DEFAULT;
  return Math.min(DIAS_MAX, Math.max(DIAS_MIN, Math.round(n)));
}

/** Nota do atendente: inteiro arredondado e clampado em 0..10; qualquer lixo vira null. */
function comoNota(valor: unknown): number | null {
  const n = comoNumero(valor);
  if (n === null) return null;
  return Math.min(NOTA_MAX, Math.max(NOTA_MIN, Math.round(n)));
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function comoMemoria(valor: unknown): MemoriaFato[] {
  if (!Array.isArray(valor)) return [];
  const saida: MemoriaFato[] = [];
  for (const item of valor) {
    if (!ehObjeto(item)) continue;
    const fato = comoTexto(item.fato, LIMITE_FATO);
    if (fato === '') continue;
    saida.push({ fato, quando_dito: comoTexto(item.quando_dito, LIMITE_QUANDO) });
    if (saida.length >= MAX_FATOS_NOVOS) break;
  }
  return saida;
}

/**
 * Compra citada: so vale objeto com descricao util. String solta ("comprou algo"),
 * numero ou objeto sem descricao viram null — melhor ficha sem compra do que compra inventada.
 */
function comoCompra(valor: unknown): CompraCitada | null {
  if (!ehObjeto(valor)) return null;
  const descricao = comoTexto(valor.descricao, LIMITE_COMPRA_DESCRICAO);
  if (descricao === '') return null;
  const bruto = comoNumero(valor.valor);
  return {
    descricao,
    valor: bruto !== null && bruto >= 0 ? bruto : null,
    quando: comoTexto(valor.quando, LIMITE_COMPRA_QUANDO),
  };
}

/**
 * Lista de candidatos a JSON dentro da resposta do modelo, do mais provavel ao menos.
 * 1) do primeiro `{` ate o ultimo `}` (cobre objeto com chaves aninhadas);
 * 2) TODOS os objetos balanceados de nivel raiz, na ordem em que aparecem — cobre
 *    preambulo com `{chaves}` soltas e ruido do tipo `{"thinking":...} {json real}`.
 */
function candidatosJson(texto: string): string[] {
  const inicio = texto.indexOf('{');
  if (inicio === -1) return [];
  const candidatos: string[] = [];
  const fim = texto.lastIndexOf('}');
  if (fim > inicio) candidatos.push(texto.slice(inicio, fim + 1));

  let abertura = -1;
  let profundidade = 0;
  let dentroDeString = false;
  let escapado = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (escapado) {
      escapado = false;
      continue;
    }
    if (dentroDeString) {
      if (c === '\\') escapado = true;
      else if (c === '"') dentroDeString = false;
      continue;
    }
    if (c === '"') dentroDeString = true;
    else if (c === '{') {
      if (profundidade === 0) abertura = i;
      profundidade++;
    } else if (c === '}' && profundidade > 0) {
      profundidade--;
      if (profundidade === 0) {
        const balanceado = texto.slice(abertura, i + 1);
        if (!candidatos.includes(balanceado)) candidatos.push(balanceado);
      }
    }
  }
  return candidatos;
}

const CHAVES_INSIGHT = [
  'resumo',
  'memoria_novos_fatos',
  'proxima_acao_em_dias',
  'proxima_acao_motivo',
  'msg_sugerida',
  // As 4 chaves da ficha 360 entram na deteccao de candidato porque um objeto que so
  // as traga ainda e um fragmento de insight vindo do modelo (e nao ruido tipo
  // {"thinking":...}). Fragmento sem resumo nao gera ficha em branco no banco: quem
  // persiste (worker) guarda contra resumo vazio antes de sobrescrever a ficha boa.
  'nota_atendimento',
  'nota_ponto_forte',
  'nota_ponto_melhoria',
  'ultima_compra',
] as const;

/** Objeto so conta como insight se trouxer ao menos uma das chaves do contrato. */
function pareceInsight(obj: Record<string, unknown>): boolean {
  return CHAVES_INSIGHT.some((chave) => chave in obj);
}

/**
 * Parse defensivo da resposta do modelo local (3B costuma sujar a saida com
 * markdown e conversa). Nunca lanca.
 * Contrato: `null` significa "nao veio JSON utilizavel" — o chamador deve tratar como
 * falha (retry / manter o insight anterior), nunca sobrescrever ficha boa com brancos.
 */
export function extrairInsight(textoModelo: string): InsightGerado | null {
  if (typeof textoModelo !== 'string' || textoModelo.trim() === '') return null;

  for (const candidato of candidatosJson(textoModelo)) {
    let bruto: unknown;
    try {
      bruto = JSON.parse(candidato);
    } catch {
      continue;
    }
    // Objeto sem nenhuma das 5 chaves e ruido (ex.: {"thinking":...}): tenta o proximo.
    if (!ehObjeto(bruto) || !pareceInsight(bruto)) continue;
    return {
      resumo: comoTexto(bruto.resumo, LIMITE_RESUMO),
      memoria_novos_fatos: comoMemoria(bruto.memoria_novos_fatos),
      proxima_acao_em_dias: comoDias(bruto.proxima_acao_em_dias),
      proxima_acao_motivo: comoTexto(bruto.proxima_acao_motivo, LIMITE_MOTIVO),
      msg_sugerida: comoTexto(bruto.msg_sugerida, LIMITE_MSG),
      nota_atendimento: comoNota(bruto.nota_atendimento),
      nota_ponto_forte: comoTexto(bruto.nota_ponto_forte, LIMITE_PONTO),
      nota_ponto_melhoria: comoTexto(bruto.nota_ponto_melhoria, LIMITE_PONTO),
      ultima_compra: comoCompra(bruto.ultima_compra),
    };
  }
  return null;
}

function normalizarFato(fato: string): string {
  return fato
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/** Une memoria antiga e nova: primeiro registro de cada fato vence, cap de 30 itens. */
export function mesclarMemoria(atual: MemoriaFato[], novos: MemoriaFato[]): MemoriaFato[] {
  const vistos = new Set<string>();
  const saida: MemoriaFato[] = [];
  for (const item of [...(atual ?? []), ...(novos ?? [])]) {
    if (!ehObjeto(item)) continue;
    const fato = comoTexto(item.fato, LIMITE_FATO);
    if (fato === '') continue;
    const chave = normalizarFato(fato);
    if (chave === '' || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push({ fato, quando_dito: comoTexto(item.quando_dito, LIMITE_QUANDO) });
  }
  return saida.slice(0, MAX_MEMORIA);
}

function formatarData(data: Date | null): string {
  if (!(data instanceof Date) || Number.isNaN(data.getTime())) return 'sem registro';
  return data.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Monta as mensagens (system + user) enviadas ao modelo para gerar o insight. */
export function montarPromptInsight(ctx: InsightContexto): AiChatMessage[] {
  const { lead, insightAnterior, mensagens } = ctx;

  const linhasLead = [
    `Nome: ${lead.nome ?? 'nao informado'}`,
    `Telefone: ${lead.telefone ?? 'nao informado'}`,
    `Etapa do funil: ${lead.etapa}`,
    `Temperatura: ${lead.temperatura}`,
    `Valor estimado: ${lead.valor_estimado === null ? 'nao informado' : `R$ ${lead.valor_estimado}`}`,
    `Ultima interacao: ${formatarData(lead.ultima_interacao)}`,
  ].join('\n');

  const blocoAnterior = insightAnterior
    ? [
        '## Ficha anterior deste lead',
        `Resumo anterior: ${insightAnterior.resumo || 'sem resumo'}`,
        'Fatos ja memorizados (nao repita em memoria_novos_fatos):',
        insightAnterior.memoria.length > 0
          ? insightAnterior.memoria.map((m) => `- ${m.fato} (dito em ${m.quando_dito || 'data desconhecida'})`).join('\n')
          : '- nenhum',
      ].join('\n')
    : '## Ficha anterior deste lead\nNao existe ficha anterior: esta e a primeira analise.';

  const blocoMensagens =
    mensagens.length > 0
      ? mensagens
          .map((m) => `[${formatarData(m.em)}] ${m.de === 'cliente' ? 'CLIENTE' : 'EQUIPE'}: ${truncar(m.texto ?? '', LIMITE_TEXTO_MENSAGEM)}`)
          .join('\n')
      : '(sem mensagens registradas)';

  const user = [
    '## Dados do lead',
    linhasLead,
    '',
    blocoAnterior,
    '',
    '## Conversa (mais antiga primeiro)',
    blocoMensagens,
    '',
    'Analise a conversa acima e responda apenas com o objeto JSON das 9 chaves.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
