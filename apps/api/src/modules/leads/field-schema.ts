/**
 * Catálogo de campos nativos e coerção de valores — paridade Kommo.
 *
 * Função pura: sem Prisma, sem Nest. É a fonte única da verdade sobre quais
 * tipos existem, quais campos nativos cada escopo expõe e como um valor cru
 * (vindo de um `<input>` ou da API pública) vira o valor tipado que vai pro
 * banco.
 *
 * Campos nativos entram na mesma lista dos customizados: o `CustomFieldDef`
 * guarda rótulo, ordem e grupo, mas quando tem `native_key` preenchida a
 * leitura/escrita vai pra COLUNA real do registro, não pro Json `dados_custom`.
 *
 * Ver docs/plans/2026-08-05-campos-personalizados-kommo.md.
 */

// Espelha o enum FieldScope do schema.prisma (mesmo padrão de common/types/roles.ts).
export const FIELD_SCOPES = ['LEAD', 'CONTATO', 'EMPRESA'] as const;
export type FieldScope = (typeof FIELD_SCOPES)[number];

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'currency',
  'date',
  'select',
  'multiselect',
  'boolean',
  'url',
  'phone',
  'email',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Tipos que exigem `options` preenchido na definição. */
export const OPTION_TYPES: readonly FieldType[] = ['select', 'multiselect'];

export interface NativeFieldSpec {
  /** Nome da coluna real no registro. Também usado como `key` da definição. */
  native_key: string;
  /** Rótulo inicial. A empresa pode renomear sem quebrar nada. */
  nome: string;
  tipo: FieldType;
  ordem: number;
  /** Campo que a UI mostra mas não deixa editar (badge "Apenas API"). */
  api_only: boolean;
  /**
   * `false` = a empresa não pode esconder nem desativar. Reservado pros campos
   * que o CRM usa como infraestrutura: esconder `Lead.telefone` quebraria envio
   * de WhatsApp e a dedupe por telefone.
   */
  removable: boolean;
  /**
   * Sem este campo a criação do lead não passa. Hoje só `nome` e `telefone`:
   * são a identidade do lead no WhatsApp e o que a dedupe usa. Todo o resto
   * pode ficar em branco — o lead é criado do mesmo jeito, no funil escolhido.
   */
  obrigatorio: boolean;
  options?: string[];
}

/** Opções de `Lead.temperatura` — espelha o enum LeadTemperatura. */
const TEMPERATURA_OPTIONS = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'];

export const NATIVE_FIELDS: Record<FieldScope, readonly NativeFieldSpec[]> = {
  LEAD: [
    { native_key: 'nome', nome: 'Nome', tipo: 'text', ordem: 0, api_only: false, removable: false, obrigatorio: true },
    { native_key: 'telefone', nome: 'Telefone/WhatsApp', tipo: 'phone', ordem: 1, api_only: false, removable: false, obrigatorio: true },
    { native_key: 'email', nome: 'E-mail', tipo: 'email', ordem: 2, api_only: false, removable: true, obrigatorio: false },
    { native_key: 'valor_estimado', nome: 'Valor estimado', tipo: 'currency', ordem: 3, api_only: false, removable: true, obrigatorio: false },
    {
      native_key: 'temperatura',
      nome: 'Temperatura',
      tipo: 'select',
      ordem: 4,
      api_only: false,
      removable: false,
      obrigatorio: false,
      options: TEMPERATURA_OPTIONS,
    },
    { native_key: 'empresa', nome: 'Empresa', tipo: 'text', ordem: 5, api_only: false, removable: true, obrigatorio: false },
    { native_key: 'cargo', nome: 'Cargo', tipo: 'text', ordem: 6, api_only: false, removable: true, obrigatorio: false },
    // Escrito pelo BroadcastDispatcher; editar à mão bagunçaria a cadência.
    { native_key: 'proximo_followup', nome: 'Próximo follow-up', tipo: 'date', ordem: 7, api_only: true, removable: true, obrigatorio: false },
  ],
  CONTATO: [
    { native_key: 'nome', nome: 'Nome de contato', tipo: 'text', ordem: 0, api_only: false, removable: false, obrigatorio: true },
    { native_key: 'telefone', nome: 'Telefone', tipo: 'phone', ordem: 1, api_only: false, removable: true, obrigatorio: false },
    { native_key: 'email', nome: 'E-mail', tipo: 'email', ordem: 2, api_only: false, removable: true, obrigatorio: false },
    { native_key: 'cargo', nome: 'Cargo', tipo: 'text', ordem: 3, api_only: false, removable: true, obrigatorio: false },
  ],
  EMPRESA: [
    { native_key: 'nome', nome: 'Nome da empresa', tipo: 'text', ordem: 0, api_only: false, removable: false, obrigatorio: true },
    { native_key: 'telefone', nome: 'Telefone', tipo: 'phone', ordem: 1, api_only: false, removable: true, obrigatorio: false },
    { native_key: 'email', nome: 'E-mail', tipo: 'email', ordem: 2, api_only: false, removable: true, obrigatorio: false },
    { native_key: 'site', nome: 'Site', tipo: 'url', ordem: 3, api_only: false, removable: true, obrigatorio: false },
    { native_key: 'endereco', nome: 'Endereço', tipo: 'textarea', ordem: 4, api_only: false, removable: true, obrigatorio: false },
  ],
};

/** Busca a spec nativa de um escopo. `undefined` = campo customizado. */
export function findNative(escopo: FieldScope, nativeKey: string): NativeFieldSpec | undefined {
  return NATIVE_FIELDS[escopo].find((f) => f.native_key === nativeKey);
}

/**
 * Erro de valor inválido. Classe própria (e não BadRequestException) pra este
 * módulo continuar livre de Nest — quem chama traduz pro HTTP.
 */
export class FieldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldValueError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s()\-.]*$/;

/**
 * Converte "1.234,56" → 1234.56. Regras, nesta ordem:
 * - tem `.` E `,` → `.` é milhar, `,` é decimal (formato BR)
 * - só `,`        → `,` é decimal
 * - só `.`        → `.` é decimal (formato US, e o que `<input type=number>` manda)
 */
function parseCurrency(raw: string): number {
  const s = raw.trim().replace(/\s/g, '');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let normalized: string;
  if (hasDot && hasComma) normalized = s.replace(/\./g, '').replace(',', '.');
  else if (hasComma) normalized = s.replace(',', '.');
  else normalized = s;
  const n = Number(normalized);
  if (!Number.isFinite(n)) throw new FieldValueError('valor monetário inválido');
  return n;
}

function asString(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new FieldValueError(`${label} precisa ser texto`);
  return raw;
}

/**
 * Coage um valor cru para o tipo do campo. Lança `FieldValueError` se não der.
 *
 * `null`, `undefined` e string vazia sempre viram `null` — "campo em branco" é
 * estado válido pra todo tipo, e é assim que a UI apaga um valor.
 */
export function coerceValue(tipo: FieldType, raw: unknown, options?: readonly string[]): unknown {
  if (raw === null || raw === undefined || raw === '') return null;

  switch (tipo) {
    case 'text':
    case 'textarea':
      return asString(raw, 'valor');

    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(asString(raw, 'valor').trim());
      if (!Number.isFinite(n)) throw new FieldValueError('precisa ser número');
      return n;
    }

    case 'currency': {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) throw new FieldValueError('valor monetário inválido');
        return raw;
      }
      return parseCurrency(asString(raw, 'valor'));
    }

    case 'date': {
      // Validação, não conversão: o formato gravado continua sendo o que a UI
      // manda (`YYYY-MM-DD` do `<input type="date">`), pra não mudar o
      // significado dos valores já existentes em dados_custom.
      const s = asString(raw, 'data').trim();
      if (Number.isNaN(Date.parse(s))) throw new FieldValueError('data inválida');
      return s;
    }

    case 'select': {
      const s = asString(raw, 'valor');
      if (options && !options.includes(s)) throw new FieldValueError('precisa ser uma das opções');
      return s;
    }

    case 'multiselect': {
      if (!Array.isArray(raw)) throw new FieldValueError('precisa ser uma lista de opções');
      const list = raw.map((v) => asString(v, 'opção'));
      if (options) {
        for (const v of list) {
          if (!options.includes(v)) throw new FieldValueError('precisa ser uma das opções');
        }
      }
      // Remove repetidos preservando a ordem em que foram marcados.
      return [...new Set(list)];
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (s === 'true') return true;
      if (s === 'false') return false;
      throw new FieldValueError('precisa ser booleano');
    }

    case 'url': {
      const s = asString(raw, 'URL').trim();
      let parsed: URL;
      try {
        parsed = new URL(s);
      } catch {
        throw new FieldValueError('URL inválida');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new FieldValueError('URL precisa ser http ou https');
      }
      return s;
    }

    case 'phone': {
      const s = asString(raw, 'telefone').trim();
      // Não normaliza: o CRM já tem essa lógica no ingest do WhatsApp e duas
      // normalizações diferentes brigariam na dedupe.
      const digits = s.replace(/\D/g, '');
      if (!PHONE_RE.test(s) || digits.length < 8 || digits.length > 15) {
        throw new FieldValueError('telefone inválido');
      }
      return s;
    }

    case 'email': {
      const s = asString(raw, 'e-mail').trim();
      if (!EMAIL_RE.test(s)) throw new FieldValueError('e-mail inválido');
      return s;
    }

    default: {
      // Exaustividade: se um tipo novo entrar em FIELD_TYPES sem case aqui, o
      // TypeScript quebra o build nesta linha.
      const exhaustive: never = tipo;
      throw new FieldValueError(`tipo desconhecido: ${String(exhaustive)}`);
    }
  }
}
