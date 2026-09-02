/**
 * Tipos e helpers de tela da timeline do lead. Os tipos espelham
 * `apps/api/src/modules/leads/lead-timeline.ts`; mudou la, muda aqui.
 */
export type Direcao = 'INCOMING' | 'OUTGOING';
export interface Pessoa { id: string; nome: string }

export interface SessaoItem {
  tipo: 'sessao'; id: string; quando: string; inicio: string; fim: string; total: number;
  recebidas: number; enviadas: number; ultima_direcao: Direcao; preview: string; instancia: string;
  primeira_mensagem_id: string; truncada: boolean;
}
export interface NotaItem {
  tipo: 'nota'; id: string; quando: string; conteudo: string; autor: Pessoa | null; mencoes: Pessoa[];
}
export interface AtividadeItem {
  tipo: 'atividade'; id: string; quando: string; subtipo: string; descricao: string;
  dados_antes: unknown; dados_depois: unknown; autor: Pessoa | null;
}
export interface TarefaItem {
  tipo: 'tarefa'; id: string; quando: string; evento: 'criada' | 'concluida'; titulo: string;
  tipo_tarefa: string; status: string; scheduled_at: string; completed_at: string | null; responsavel: Pessoa | null;
}
export interface LembreteItem {
  tipo: 'lembrete'; id: string; quando: string; motivo: string; avisar_em: string; status: string; origem: string;
}
export type TimelineItem = SessaoItem | NotaItem | AtividadeItem | TarefaItem | LembreteItem;
export interface TimelinePage { items: TimelineItem[]; nextCursor?: string }

export type Categoria = 'tudo' | 'conversas' | 'notas' | 'tarefas' | 'eventos';
export const CATEGORIAS: { key: Categoria; label: string }[] = [
  { key: 'tudo', label: 'Tudo' },
  { key: 'conversas', label: 'Conversas' },
  { key: 'notas', label: 'Notas' },
  { key: 'tarefas', label: 'Tarefas' },
  { key: 'eventos', label: 'Eventos' },
];

export function categoriaDoItem(item: TimelineItem): Exclude<Categoria, 'tudo'> {
  switch (item.tipo) {
    case 'sessao': return 'conversas';
    case 'nota': return 'notas';
    case 'tarefa':
    case 'lembrete': return 'tarefas';
    case 'atividade': return 'eventos';
  }
}

export function filtrarPorCategoria(items: TimelineItem[], cat: Categoria): TimelineItem[] {
  if (cat === 'tudo') return items;
  return items.filter((i) => categoriaDoItem(i) === cat);
}

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function rotuloSessao(s: SessaoItem): string {
  const qtd = s.total === 1 ? '1 mensagem' : `${s.total} mensagens`;
  const faixa = s.total === 1 ? hora(s.fim) : `${hora(s.inicio)}–${hora(s.fim)}`;
  return `${qtd} · ${faixa}${s.truncada ? ' (cortada em 500)' : ''}`;
}

export function rotuloTarefa(t: TarefaItem): string {
  return `${t.evento === 'concluida' ? 'Tarefa concluída' : 'Tarefa criada'}: ${t.titulo}`;
}

export function rotuloLembrete(l: LembreteItem): string {
  const origem = l.origem === 'ia' ? 'Lembrete da IA' : 'Lembrete';
  return `${origem}: ${l.motivo}`;
}

/** 'YYYY-MM-DD' no fuso local — chave de agrupamento e do cabecalho de dia. */
function diaLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function agruparPorDia(items: TimelineItem[]): { dia: string; items: TimelineItem[] }[] {
  const grupos: { dia: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const dia = diaLocal(item.quando);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.dia === dia) ultimo.items.push(item);
    else grupos.push({ dia, items: [item] });
  }
  return grupos;
}

export type TipoMidia = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
const ROTULO_MIDIA: Record<string, string> = {
  IMAGE: 'Imagem', VIDEO: 'Vídeo', AUDIO: 'Áudio', DOCUMENT: 'Documento',
};
export function rotuloMidia(type: string, filename: string | null): string {
  if (type.toUpperCase() === 'DOCUMENT' && filename) return filename;
  return ROTULO_MIDIA[type.toUpperCase()] ?? type;
}
