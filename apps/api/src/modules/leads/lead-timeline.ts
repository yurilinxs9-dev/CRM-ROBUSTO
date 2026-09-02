/**
 * Helpers puros da timeline do lead. Sem Prisma: recebem linhas já lidas e
 * devolvem os itens que a página consome. Ver spec
 * docs/superpowers/specs/2026-09-02-ficha-lead-timeline-design.md.
 */
export const SESSAO_GAP_MS = 30 * 60_000;
export const SESSAO_MAX_MENSAGENS = 500;
export const PREVIEW_MAX = 140;

export type Direcao = 'INCOMING' | 'OUTGOING';

export interface MensagemParaSessao {
  id: string;
  created_at: Date;
  direction: Direcao;
  type: string;
  content: string | null;
  instance_name: string;
}

export interface SessaoItem {
  tipo: 'sessao';
  id: string;
  quando: string;
  inicio: string;
  fim: string;
  total: number;
  recebidas: number;
  enviadas: number;
  ultima_direcao: Direcao;
  preview: string;
  instancia: string;
  primeira_mensagem_id: string;
  truncada: boolean;
}

export interface Pessoa {
  id: string;
  nome: string;
}

export interface NotaItem {
  tipo: 'nota';
  id: string;
  quando: string;
  conteudo: string;
  autor: Pessoa | null;
  mencoes: Pessoa[];
}

export interface AtividadeItem {
  tipo: 'atividade';
  id: string;
  quando: string;
  subtipo: string;
  descricao: string;
  dados_antes: unknown;
  dados_depois: unknown;
  autor: Pessoa | null;
}

export interface TarefaItem {
  tipo: 'tarefa';
  id: string;
  quando: string;
  evento: 'criada' | 'concluida';
  titulo: string;
  tipo_tarefa: string;
  status: string;
  scheduled_at: string;
  completed_at: string | null;
  responsavel: Pessoa | null;
}

export interface LembreteItem {
  tipo: 'lembrete';
  id: string;
  quando: string;
  motivo: string;
  avisar_em: string;
  status: string;
  origem: string;
}

export type TimelineItem = SessaoItem | NotaItem | AtividadeItem | TarefaItem | LembreteItem;

const ROTULO_MIDIA: Record<string, string | undefined> = {
  IMAGE: '[Imagem]',
  VIDEO: '[Vídeo]',
  AUDIO: '[Áudio]',
  DOCUMENT: '[Documento]',
  STICKER: '[Figurinha]',
  LOCATION: '[Localização]',
  CONTACT: '[Contato]',
};

/** Corta por code point, para nao partir emoji/acento composto no meio. */
function cortarPreview(texto: string): string {
  return [...texto].slice(0, PREVIEW_MAX).join('');
}

export function previewDaMensagem(m: Pick<MensagemParaSessao, 'type' | 'content'>): string {
  const texto = (m.content ?? '').trim();
  const rotulo = ROTULO_MIDIA[m.type.toUpperCase()];
  if (rotulo) return texto ? cortarPreview(`${rotulo} ${texto}`) : rotulo;
  return cortarPreview(texto);
}

/** `proxima` é a mensagem mais ANTIGA (a lista chega desc). */
export function mesmaSessao(atual: Date, proxima: Date, gapMs = SESSAO_GAP_MS): boolean {
  return atual.getTime() - proxima.getTime() <= gapMs;
}

/**
 * Entrada desc (mais nova primeiro). Cada sessão nasce na mensagem mais nova
 * do bloco e cresce para trás até o gap ou o teto. `quando` = `fim`, para a
 * sessão ordenar junto dos outros itens pela última mensagem.
 *
 * `truncada: true` marca APENAS o corte artificial pelo teto: a conversa
 * continua ANTES de `inicio`, na próxima sessão da lista. Corte por gap de
 * 30 min é fim de sessão de verdade e sai com `truncada: false`.
 */
export function agruparSessoes(
  mensagens: MensagemParaSessao[],
  gapMs = SESSAO_GAP_MS,
): SessaoItem[] {
  const sessoes: SessaoItem[] = [];
  let bloco: MensagemParaSessao[] = [];

  const fechar = (truncada: boolean) => {
    if (bloco.length === 0) return;
    const ultima = bloco[0];
    const primeira = bloco[bloco.length - 1];
    sessoes.push({
      tipo: 'sessao',
      id: `sessao-${primeira.id}`,
      quando: ultima.created_at.toISOString(),
      inicio: primeira.created_at.toISOString(),
      fim: ultima.created_at.toISOString(),
      total: bloco.length,
      recebidas: bloco.filter((m) => m.direction === 'INCOMING').length,
      enviadas: bloco.filter((m) => m.direction === 'OUTGOING').length,
      ultima_direcao: ultima.direction,
      preview: previewDaMensagem(ultima),
      instancia: ultima.instance_name,
      primeira_mensagem_id: primeira.id,
      truncada,
    });
    bloco = [];
  };

  for (const m of mensagens) {
    if (bloco.length === 0) {
      bloco.push(m);
      continue;
    }
    const anterior = bloco[bloco.length - 1];
    // O gap manda: so quem passou do teto DENTRO da mesma sessao sai truncado.
    if (!mesmaSessao(anterior.created_at, m.created_at, gapMs)) {
      fechar(false);
    } else if (bloco.length >= SESSAO_MAX_MENSAGENS) {
      fechar(true);
    }
    bloco.push(m);
  }
  fechar(false);
  return sessoes;
}

export interface TimelineCursor {
  quando: string;
  id: string;
  /** `inicio` da sessao mais ANTIGA ja servida; limite superior das mensagens. */
  mensagensAntes?: string;
}

/** Serializa o cursor composto como `quando|id|mensagensAntes` (3o campo pode vir vazio). */
export function codificarCursor(c: TimelineCursor): string {
  return `${c.quando}|${c.id}|${c.mensagensAntes ?? ''}`;
}

/**
 * Aceita 2 ou 3 partes (terceira vazia = ausente). Devolve null se faltar
 * `quando`/`id`, se sobrar parte, ou se `quando`/`mensagensAntes` nao forem ISO.
 */
export function decodificarCursor(s: string): TimelineCursor | null {
  const partes = s.split('|');
  if (partes.length < 2 || partes.length > 3) return null;
  const [quando, id, mensagensAntes] = partes;
  if (!quando || !id) return null;
  if (Number.isNaN(Date.parse(quando))) return null;
  if (mensagensAntes) {
    if (Number.isNaN(Date.parse(mensagensAntes))) return null;
    return { quando, id, mensagensAntes };
  }
  return { quando, id };
}

/** Ordem canonica da timeline: `quando` desc, desempate por `id` desc. */
function compararItens(a: TimelineItem, b: TimelineItem): number {
  if (a.quando !== b.quando) return a.quando < b.quando ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * Mescla as fontes na ordem canonica (`quando` desc, `id` desc) e corta em
 * `limit`.
 *
 * Contrato de paginação para o chamador (Task 3):
 * - Notas e demais fontes: consultar com `created_at <= cursor.quando`
 *   (INCLUSIVO). O desempate fica com o filtro em memória daqui, que descarta
 *   o que ja foi servido (`quando` igual ao do cursor com `id` >= `cursor.id`).
 *   Sem isso, itens com timestamp identico na fronteira somem (`<`) ou
 *   repetem (`<=`).
 * - Mensagens (fonte das sessões): quando `cursor.mensagensAntes` existe,
 *   consultar com `created_at < cursor.mensagensAntes` (ESTRITO); sem o campo,
 *   sem limite superior. Isso impede que uma nota escrita no MEIO de uma sessão
 *   ja servida faça a pagina seguinte reagrupar um pedaço dessa sessão.
 *
 * `nextCursor` carrega `mensagensAntes` = menor `inicio` entre as sessões desta
 * pagina; se a pagina nao tiver sessão, repete o valor que veio no cursor.
 *
 * `horizonteMensagens` (so quando a fonte de sessões ainda tem mais) e o
 * `inicio` da sessão mais ANTIGA construida nesta pagina — ate onde as
 * mensagens foram lidas. A pagina e cortada nesse ponto: item abaixo dele fica
 * para a proxima pagina. Sem esse corte, uma pagina cheia de itens VELHOS (as
 * demais fontes vao muito mais para tras que as mensagens) deixaria
 * `cursor.quando` ABAIXO do horizonte, e as sessões remontadas na pagina
 * seguinte — vindas de mensagens entre `cursor.quando` e `mensagensAntes` —
 * nasceriam com `quando` MAIOR que o cursor e o filtro daqui as apagaria para
 * sempre. O que foi cortado volta na proxima pagina: as fontes por data leem
 * com `<= cursor.quando` e o novo `cursor.quando` fica >= o horizonte.
 */
export function mesclarTimeline(
  fontes: TimelineItem[][],
  limit: number,
  algumaFonteTemMais: boolean,
  cursor?: TimelineCursor,
  horizonteMensagens?: string,
): { items: TimelineItem[]; nextCursor?: string } {
  const ordenados = fontes.flat().sort(compararItens);
  const aposCursor = cursor
    ? ordenados.filter(
        (i) => i.quando < cursor.quando || (i.quando === cursor.quando && i.id < cursor.id),
      )
    : ordenados;
  // O horizonte e inclusivo: a sessão mais antiga da pagina tem `quando` >=
  // `inicio`, entao ela sempre sobrevive ao corte (a pagina nunca fica vazia).
  const restantes = horizonteMensagens
    ? aposCursor.filter((i) => i.quando >= horizonteMensagens)
    : aposCursor;
  const items = restantes.slice(0, limit);
  const sobrou = restantes.length > limit;
  if (items.length === 0 || !(sobrou || algumaFonteTemMais)) return { items, nextCursor: undefined };

  const ultimo = items[items.length - 1];
  const sessoes = items.filter((i): i is SessaoItem => i.tipo === 'sessao');
  const mensagensAntes =
    sessoes.length > 0
      ? sessoes.reduce((menor, s) => (s.inicio < menor ? s.inicio : menor), sessoes[0].inicio)
      : cursor?.mensagensAntes;
  const proximo: TimelineCursor = { quando: ultimo.quando, id: ultimo.id };
  if (mensagensAntes) proximo.mensagensAntes = mensagensAntes;
  return { items, nextCursor: codificarCursor(proximo) };
}
