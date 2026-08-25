/**
 * Config de view salva (LeadView.tipo_padrao/sort/colunas/card_fields) — a
 * parte que é conta pura, no padrão de lead-filters.ts. O Json vem do banco
 * gravado por qualquer versão do cliente: cada campo é conferido e cai no
 * default quando não bate, pra view antiga abrir em vez de derrubar a tela.
 */

export type ViewMode = 'kanban' | 'lista';
export interface ViewSort { campo: string; dir: 'asc' | 'desc' }
export interface ViewColumn { key: string; width?: number }
export interface LeadViewConfig {
  tipo_padrao: ViewMode;
  sort: ViewSort | null;
  colunas: ViewColumn[];
  card_fields: string[];
}

export const CONFIG_VAZIA: LeadViewConfig = { tipo_padrao: 'kanban', sort: null, colunas: [], card_fields: [] };

/** Colunas que a tabela mostra sem view ativa (ou view sem colunas salvas). */
export const COLUNAS_DEFAULT: ViewColumn[] = [
  { key: 'nome' }, { key: 'telefone' }, { key: 'estagio' }, { key: 'temperatura' },
  { key: 'valor_estimado' }, { key: 'responsavel' }, { key: 'ultima_interacao' },
];

const clampWidth = (w: unknown): number | undefined =>
  typeof w === 'number' && Number.isFinite(w) ? Math.min(640, Math.max(60, Math.round(w))) : undefined;

export function fromSavedConfig(bruto: unknown): LeadViewConfig {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { ...CONFIG_VAZIA };
  const o = bruto as Record<string, unknown>;

  const tipo: ViewMode = o.tipo_padrao === 'lista' ? 'lista' : 'kanban';

  let sort: ViewSort | null = null;
  if (o.sort && typeof o.sort === 'object' && !Array.isArray(o.sort)) {
    const s = o.sort as Record<string, unknown>;
    if (typeof s.campo === 'string' && s.campo.trim() && (s.dir === 'asc' || s.dir === 'desc')) {
      sort = { campo: s.campo, dir: s.dir };
    }
  }

  const colunas: ViewColumn[] = Array.isArray(o.colunas)
    ? o.colunas.flatMap((c): ViewColumn[] => {
        if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
        const col = c as Record<string, unknown>;
        if (typeof col.key !== 'string' || !col.key.trim()) return [];
        const width = clampWidth(col.width);
        return [width !== undefined ? { key: col.key, width } : { key: col.key }];
      })
    : [];

  const card_fields = Array.isArray(o.card_fields)
    ? o.card_fields.filter((v): v is string => typeof v === 'string' && !!v.trim())
    : [];

  return { tipo_padrao: tipo, sort, colunas, card_fields };
}

export function configIgual(a: LeadViewConfig, b: LeadViewConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
