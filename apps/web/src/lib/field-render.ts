/**
 * Lógica pura da ficha de campos — paridade Kommo.
 *
 * O ponto central: campo NATIVO e campo CUSTOMIZADO aparecem na mesma lista
 * ordenável, mas guardam o valor em lugares diferentes. `native_key` decide:
 * preenchida = coluna real do registro (`lead.nome`); nula = chave dentro do
 * Json `dados_custom`. `readValue` e `buildPayload` são os dois lados dessa
 * tradução, e são a única parte do frontend com teste unitário (o runner do
 * apps/web só cobre `src/lib`).
 */

export type FieldScope = 'LEAD' | 'CONTATO' | 'EMPRESA';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'currency'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'url'
  | 'phone'
  | 'email';

export interface FieldDef {
  id: string;
  nome: string;
  key: string;
  tipo: FieldType;
  options: string[] | null;
  ordem: number;
  active: boolean;
  escopo: FieldScope;
  group_id: string | null;
  native_key: string | null;
  api_only: boolean;
  visible: boolean;
}

export interface FieldGroup {
  id: string;
  nome: string;
  escopo: FieldScope;
  ordem: number;
  is_system: boolean;
}

export interface FieldSchema {
  groups: FieldGroup[];
  fields: FieldDef[];
}

export interface GroupWithFields extends FieldGroup {
  fields: FieldDef[];
}

/** Registro genérico da ficha (lead, contato ou empresa). */
export type FieldRecord = Record<string, unknown> & {
  dados_custom?: Record<string, unknown> | null;
};

/**
 * Como cada campo nativo do LEAD viaja até `PATCH /leads/:id`.
 *
 * Isto existe porque `updateLeadSchema` no backend não é uniforme: `nome` e
 * `telefone` têm mínimo e não aceitam null, `email` e `valor_estimado` aceitam,
 * e `valor_estimado` é `z.string()` — mandar número dá 400. Campo customizado
 * não entra aqui: o backend coage sozinho via `coerceValue`.
 */
const LEAD_NATIVE_WIRE: Record<string, 'obrigatorio' | 'anulavel' | 'moeda' | 'cru'> = {
  nome: 'obrigatorio',
  telefone: 'obrigatorio',
  email: 'anulavel',
  valor_estimado: 'moeda',
  empresa: 'anulavel',
  cargo: 'anulavel',
  temperatura: 'cru',
};

/** Agrupa os campos de um escopo nas suas abas, já ordenados. */
export function groupFields(
  schema: FieldSchema,
  escopo: FieldScope,
  opts: { incluirOcultos?: boolean } = {},
): GroupWithFields[] {
  const grupos = schema.groups
    .filter((g) => g.escopo === escopo)
    .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome));

  return grupos.map((g) => ({
    ...g,
    fields: schema.fields
      .filter(
        (f) =>
          f.escopo === escopo &&
          f.active &&
          f.group_id === g.id &&
          (opts.incluirOcultos || f.visible),
      )
      .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome)),
  }));
}

/** Lê o valor de um campo no registro, na coluna ou no Json. */
export function readValue(def: FieldDef, record: FieldRecord | null | undefined): unknown {
  if (!record) return undefined;
  if (def.native_key) return record[def.native_key];
  const custom = record.dados_custom;
  return custom ? custom[def.key] : undefined;
}

/** Normaliza "1.234,56" → "1234.56" (o backend exige string em valor_estimado). */
function moedaParaWire(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  const s = String(raw).trim().replace(/\s/g, '');
  if (!s) return null;
  const temPonto = s.includes('.');
  const temVirgula = s.includes(',');
  let norm: string;
  if (temPonto && temVirgula) norm = s.replace(/\./g, '').replace(',', '.');
  else if (temVirgula) norm = s.replace(',', '.');
  else norm = s;
  return Number.isFinite(Number(norm)) ? norm : null;
}

function vazio(v: unknown): boolean {
  return v === '' || v === null || v === undefined;
}

/**
 * Separa os valores editados em dois destinos: colunas (`native`) e Json
 * (`custom`). O chamador faz `{ ...native, dados_custom: custom }`.
 *
 * Não entra no payload: campo oculto, campo `api_only` (é justamente o sentido
 * do badge "Apenas API" — bloqueado na UI, liberado na integração), campo não
 * tocado (`undefined`), e nativo obrigatório que ficou vazio — mandar `nome: ''`
 * levaria 400 do Zod e derrubaria o save inteiro.
 */
export function buildPayload(
  defs: FieldDef[],
  values: Record<string, unknown>,
): { native: Record<string, unknown>; custom: Record<string, unknown> } {
  const native: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};

  for (const def of defs) {
    if (!def.visible || !def.active || def.api_only) continue;
    const valor = values[def.key];
    if (valor === undefined) continue;

    if (!def.native_key) {
      custom[def.key] = vazio(valor) ? null : valor;
      continue;
    }

    const modo = LEAD_NATIVE_WIRE[def.native_key] ?? 'anulavel';
    if (modo === 'obrigatorio') {
      if (vazio(valor)) continue;
      native[def.native_key] = valor;
    } else if (modo === 'moeda') {
      native[def.native_key] = vazio(valor) ? null : moedaParaWire(valor);
    } else if (modo === 'cru') {
      if (!vazio(valor)) native[def.native_key] = valor;
    } else {
      native[def.native_key] = vazio(valor) ? null : valor;
    }
  }

  return { native, custom };
}

/** Valor inicial de um campo no formulário, já no formato que o input espera. */
export function initialValue(def: FieldDef, record: FieldRecord | null | undefined): unknown {
  const bruto = readValue(def, record);
  if (bruto === null || bruto === undefined) {
    return def.tipo === 'multiselect' ? [] : def.tipo === 'boolean' ? undefined : '';
  }
  if (def.tipo === 'multiselect') return Array.isArray(bruto) ? bruto : [];
  if (def.tipo === 'boolean') return typeof bruto === 'boolean' ? bruto : undefined;
  return typeof bruto === 'string' ? bruto : String(bruto);
}

/** Monta o mapa `key -> valor` de um registro, para popular o formulário. */
export function initialValues(defs: FieldDef[], record: FieldRecord | null | undefined) {
  const out: Record<string, unknown> = {};
  for (const def of defs) out[def.key] = initialValue(def, record);
  return out;
}

/** Achata os grupos numa lista só de campos (para `buildPayload`). */
export function flattenFields(grupos: GroupWithFields[]): FieldDef[] {
  return grupos.flatMap((g) => g.fields);
}
