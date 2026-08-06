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
  /**
   * Sem preencher, a criação não passa. Derivado no backend a partir de
   * NATIVE_FIELDS — hoje só Nome e Telefone. Opcional no tipo porque o backend
   * antigo não manda esta chave.
   */
  obrigatorio?: boolean;
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

/**
 * Remove as chaves nulas de um payload.
 *
 * Em EDIÇÃO, `null` é intencional: significa "apague este valor". Em CRIAÇÃO
 * não existe valor anterior para apagar, então `null` só quer dizer "não
 * informado" — e mandá-lo quebra, porque `createLeadSchema` declara os campos
 * como `.optional()` sem `.nullable()`. Era o 400 por trás de "Erro ao criar
 * lead" quando qualquer campo opcional ficava em branco.
 */
/**
 * Devolve os RÓTULOS dos campos obrigatórios que ficaram em branco.
 *
 * Usa `def.nome`, que é o rótulo que a empresa configurou — a mensagem de erro
 * fala a língua da tela, não a do banco ("Telefone/WhatsApp", não "telefone").
 */
export function faltandoObrigatorios(
  defs: FieldDef[],
  values: Record<string, unknown>,
): string[] {
  const faltando: string[] = [];
  for (const def of defs) {
    if (!def.obrigatorio || !def.visible || !def.active || def.api_only) continue;
    const v = values[def.key];
    const vazio =
      v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
    if (vazio) faltando.push(def.nome);
  }
  return faltando;
}

export function semNulos(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Modo de compatibilidade com o backend antigo
// ---------------------------------------------------------------------------

/**
 * Formato devolvido por `GET /custom-fields` no backend ANTIGO (julho/2026),
 * que não conhece escopo, grupo nem campo nativo.
 */
export interface LegacyFieldDef {
  id: string;
  nome: string;
  key: string;
  tipo: FieldType;
  options: string[] | null;
  ordem: number;
  active: boolean;
}

export const SYNTHETIC_PREFIX = '__nativo_';

/** Campo nativo montado no cliente não existe como linha no banco. */
export function isSynthetic(def: FieldDef): boolean {
  return def.id.startsWith(SYNTHETIC_PREFIX);
}

const LEGACY_GROUP_ID = '__grupo_legado__';

/**
 * Nativos que o backend ANTIGO realmente persiste — a lista é exatamente o
 * `updateLeadSchema` daquela versão. `empresa` e `cargo` ficam de fora de
 * propósito: aquele schema não os aceita e o Zod descartaria a chave em
 * silêncio, dando "salvo com sucesso" e perdendo o que o usuário digitou.
 */
const LEGACY_NATIVOS: Array<[string, string, FieldType, string[] | null, boolean]> = [
  ['nome', 'Nome', 'text', null, true],
  ['telefone', 'Telefone/WhatsApp', 'phone', null, true],
  ['email', 'E-mail', 'email', null, false],
  ['valor_estimado', 'Valor estimado', 'currency', null, false],
  ['temperatura', 'Temperatura', 'select', ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'], false],
];

/**
 * Monta um `FieldSchema` a partir do que o backend antigo devolve, para a ficha
 * nova funcionar antes do backend ser atualizado.
 *
 * Só existe escopo LEAD e um único grupo: contato, empresa, grupos e
 * reordenação dependem de rotas que aquele backend não tem, e a UI esconde
 * essas partes no modo legado em vez de oferecer botão que dá 404.
 */
export function schemaFromLegacy(legacy: LegacyFieldDef[]): FieldSchema {
  const nativos: FieldDef[] = LEGACY_NATIVOS.map(
    ([nativeKey, nome, tipo, options, obrigatorio], i) => ({
      id: `${SYNTHETIC_PREFIX}${nativeKey}`,
      nome,
      key: nativeKey,
      tipo,
      options,
      ordem: i,
      active: true,
      escopo: 'LEAD' as const,
      group_id: LEGACY_GROUP_ID,
      native_key: nativeKey,
      api_only: false,
      visible: true,
      obrigatorio,
    }),
  );

  const customizados: FieldDef[] = legacy
    .filter((f) => f.active)
    .map((f) => ({
      ...f,
      escopo: 'LEAD' as const,
      group_id: LEGACY_GROUP_ID,
      native_key: null,
      api_only: false,
      visible: true,
      // Depois dos nativos, preservando a ordem relativa entre eles.
      ordem: LEGACY_NATIVOS.length + f.ordem,
    }));

  return {
    groups: [
      { id: LEGACY_GROUP_ID, nome: 'Principal', escopo: 'LEAD', ordem: 0, is_system: true },
    ],
    fields: [...nativos, ...customizados],
  };
}
