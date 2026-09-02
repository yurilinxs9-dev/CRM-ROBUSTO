import { TEMP_LABELS, type Temperatura } from '@/components/kanban/lead-card';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadTag {
  id: string;
  nome: string;
  cor: string;
}

export interface LeadContactLink {
  contact_id: string;
  is_principal: boolean;
  contact: {
    id: string;
    nome: string;
    company_id?: string | null;
    company?: { id: string; nome: string } | null;
  };
}

// `type` e não `interface`: só alias de objeto recebe index signature implícita,
// e sem ela o TypeScript recusa passar o lead para readValue/initialValues, que
// aceitam FieldRecord (Record<string, unknown>).
export type LeadDetail = {
  id: string;
  nome: string;
  telefone: string;
  email?: string | null;
  temperatura: Temperatura;
  valor_estimado?: string | null;
  empresa?: string | null;
  cargo?: string | null;
  foto_url?: string | null;
  responsavel?: { id: string; nome: string; avatar_url?: string | null } | null;
  /** Null no lead que está na nuvem do escritório (sem dono). */
  responsavel_id: string | null;
  tags?: string[] | null;
  lead_tags?: { tag: LeadTag }[];
  pipeline_id: string;
  estagio_id: string;
  // `GET /api/leads/:id` já traz o estágio inteiro e a última interação — a
  // Ficha 360 lê os dois daqui em vez de disparar um fetch próprio.
  estagio?: { nome: string } | null;
  ultima_interacao?: string | null;
  dados_custom?: Record<string, unknown> | null;
  lead_contacts?: LeadContactLink[];
  /** Instância de WhatsApp por onde o lead conversa. */
  instancia_whatsapp?: string | null;
  /** Lead privado: só o dono e os gestores enxergam. */
  is_private?: boolean;
  arquivado?: boolean;
  /** Carimbo da devolução ao escritório: sem dono + preenchido = lead na nuvem. */
  returned_at?: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `valor_estimado` é Decimal(12,2): chega como string do Nest. */
export function lerValorEstimado(valor: string | null | undefined): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * O CRM tem DOIS estoques de tag e a precedência é a MESMA do backend
 * (`tagsDoLead` do radar) e da tabela de leads: a relação `lead_tags` ganha
 * quando existe; a coluna Json `tags` é o fallback legado. Coalescer por
 * nullish (`lead.tags ?? relação`) não funciona — `Lead.tags` é Json com
 * default `[]`, então quase nunca é nullish e o fallback nunca rodaria: lead
 * vindo da public API mostraria tags no Radar e nenhuma aqui.
 */
export function tagsDoLead(lead: LeadDetail): string[] {
  const daRelacao = lead.lead_tags?.map((lt) => lt.tag.nome) ?? [];
  if (daRelacao.length > 0) return daRelacao;
  return tagsDoJson(lead);
}

/** Json cru: nada no banco impede número, null ou objeto no meio da lista. */
export function tagsDoJson(lead: LeadDetail): string[] {
  if (!Array.isArray(lead.tags)) return [];
  return lead.tags.filter((t) => typeof t === 'string' && t.trim() !== '');
}

/**
 * O que o TagPicker recebe ao abrir a ficha: a UNIÃO dos dois estoques, não a
 * precedência da exibição.
 *
 * Os dois estoques DESSINCRONIZAM: a public API grava na relação `lead_tags`, o
 * picker grava só o Json `tags`. Exibir relação-first é certo (é a fonte mais
 * confiável quando existe), mas SEEDAR relação-first poda: lead com relação
 * ['A'] e Json ['A','B'] entraria no editor como ['A'], e o Salvar PATCHa
 * `tags: ['A']` — 'B' some do Json de vez, e o card do Kanban lê só o Json.
 * União no editor: nada é apagado por ter sido gravado no outro estoque.
 */
export function tagsParaEditar(lead: LeadDetail): string[] {
  return [...new Set([...(lead.lead_tags?.map((lt) => lt.tag.nome) ?? []), ...tagsDoJson(lead)])];
}

export const GESTORES = ['GERENTE', 'SUPER_ADMIN'];

/** VISUALIZADOR entra na ficha em modo leitura: nada nela é editável. */
export function podeEditar(role: string | undefined): boolean {
  return !!role && role !== 'VISUALIZADOR';
}

export const TEMP_OPCOES: { value: Temperatura; label: string }[] = (
  ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'] as Temperatura[]
).map((t) => ({ value: t, label: TEMP_LABELS[t] }));
