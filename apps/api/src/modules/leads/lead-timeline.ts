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

const ROTULO_MIDIA: Record<string, string> = {
  IMAGE: '[Imagem]',
  VIDEO: '[Vídeo]',
  AUDIO: '[Áudio]',
  DOCUMENT: '[Documento]',
  STICKER: '[Figurinha]',
  LOCATION: '[Localização]',
  CONTACT: '[Contato]',
};

export function previewDaMensagem(m: Pick<MensagemParaSessao, 'type' | 'content'>): string {
  const texto = (m.content ?? '').trim();
  const rotulo = ROTULO_MIDIA[m.type.toUpperCase()];
  if (rotulo) return texto ? `${rotulo} ${texto}`.slice(0, PREVIEW_MAX) : rotulo;
  return texto.slice(0, PREVIEW_MAX);
}

/** `proxima` é a mensagem mais ANTIGA (a lista chega desc). */
export function mesmaSessao(atual: Date, proxima: Date, gapMs = SESSAO_GAP_MS): boolean {
  return atual.getTime() - proxima.getTime() <= gapMs;
}

/**
 * Entrada desc (mais nova primeiro). Cada sessão nasce na mensagem mais nova
 * do bloco e cresce para trás até o gap ou o teto. `quando` = `fim`, para a
 * sessão ordenar junto dos outros itens pela última mensagem.
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
    if (bloco.length >= SESSAO_MAX_MENSAGENS) {
      fechar(true);
      bloco.push(m);
      continue;
    }
    if (mesmaSessao(anterior.created_at, m.created_at, gapMs)) {
      bloco.push(m);
    } else {
      fechar(false);
      bloco.push(m);
    }
  }
  fechar(false);
  return sessoes;
}

export function mesclarTimeline(
  fontes: TimelineItem[][],
  limit: number,
  algumaFonteTemMais: boolean,
): { items: TimelineItem[]; nextCursor?: string } {
  const todos = fontes
    .flat()
    .sort((a, b) => (a.quando < b.quando ? 1 : a.quando > b.quando ? -1 : 0));
  const items = todos.slice(0, limit);
  const sobrou = todos.length > limit;
  const nextCursor =
    items.length > 0 && (sobrou || algumaFonteTemMais) ? items[items.length - 1].quando : undefined;
  return { items, nextCursor };
}
