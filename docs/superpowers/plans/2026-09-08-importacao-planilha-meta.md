# Importação da planilha Meta Lead Ads — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O backend do CRM lê a planilha pública do Google Sheets alimentada pelo Meta Lead Ads a cada 5 minutos e transforma cada linha nova em lead (etapa Novo, sem dono, campos custom, tags, atribuição, atividade) e enfileira a Ficha IA em modo pré-contato.

**Architecture:** Módulo NestJS novo `sheet-import` (parser puro + service com cron), tabela nova `SheetImportRow` para dedupe por linha, e extensão do módulo `lead-insights` para gerar ficha a partir do cadastro quando ainda não há conversa. Configuração por env, sem tela.

**Tech Stack:** NestJS 10, Prisma 5.22 (Supabase Postgres), `@nestjs/schedule`, BullMQ (fila `lead-insights` existente), Jest 30 + ts-jest, Zod, `fetch` nativo do Node 20+.

Spec: `docs/superpowers/specs/2026-09-08-importacao-planilha-meta-design.md`.

## Global Constraints

- Nunca `any` no TypeScript (CLAUDE.md regra 2). Em spec, casts `as unknown as X` uma vez no construtor, como em `lead-insights.service.spec.ts`.
- Nunca `prisma migrate deploy` nem `db push`. Migration nova: SQL só de objeto novo em `prisma/migrations/<ts>_sheet_import_row/migration.sql`, aplicada por script `scripts/apply-sheet-import.mjs` via `DIRECT_URL`, registrada com `migrate resolve --applied`.
- Nenhum `ALTER TABLE` em tabela existente. `SheetImportRow` sem FK.
- Prisma CLI: `node ../../node_modules/prisma/build/index.js <cmd>` (cwd `apps/api`), nunca `npx prisma`.
- Testes: `cd apps/api && npx jest <caminho>` (rootDir `src`, regex `.spec.ts`).
- Typecheck: `cd apps/api && npm run typecheck`. Lint: `npm run lint`.
- WebSocket após mutação de lead (regra 8): `CrmGateway.emitLeadCreated`.
- Telefone gravado só com dígitos, com DDI 55, igual ao inbound (`inbound-message.service.ts` grava `phone` do JID).
- Envs novas: `SHEET_IMPORT_TENANT_ID`, `SHEET_IMPORT_SHEET_ID`, `SHEET_IMPORT_GID`, `SHEET_IMPORT_PIPELINE_ID`, `SHEET_IMPORT_STAGE_ID`. Sem as duas primeiras o módulo é inerte.
- Commits em português, tipo `feat(api):` / `test(api):` / `docs:` / `chore(api):`. Trailer:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019yn95MN9qv485NkJDaKVy8
```

- Branch: `feat/importacao-planilha-meta` (já existe, com o spec commitado).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `apps/api/src/modules/sheet-import/sheet-import.parser.ts` | Funções puras: CSV, telefone, classificação MEI, linha de teste, `mapRow`. Sem Nest/Prisma. |
| `apps/api/src/modules/sheet-import/sheet-import.parser.spec.ts` | Testes do parser. |
| `apps/api/src/modules/sheet-import/sheet-import.fields.ts` | Catálogo das definições de campo custom do grupo "Formulário Meta" (chaves, rótulos, tipos, opções). |
| `apps/api/src/modules/sheet-import/sheet-import.service.ts` | Config, fetch, hash, registro de linhas, criar/anexar lead, cron. |
| `apps/api/src/modules/sheet-import/sheet-import.service.spec.ts` | Testes do service com Prisma/fetch mockados. |
| `apps/api/src/modules/sheet-import/sheet-import.module.ts` | Wiring Nest. |
| `apps/api/src/app.module.ts` | Registra `SheetImportModule`. |
| `apps/api/prisma/schema.prisma` | Model `SheetImportRow`. |
| `apps/api/prisma/migrations/20260908120000_sheet_import_row/migration.sql` | DDL aditiva. |
| `apps/api/scripts/apply-sheet-import.mjs` | Aplicador da migration (cópia adaptada de `apply-attribution.mjs`). |
| `apps/api/src/modules/leads/custom-fields.service.ts` | `ensureBootstrap` vira público (`ensureTenantBootstrap`). |
| `apps/api/src/modules/lead-insights/insight-prompt.ts` | Bloco "Cadastro e formulário" + modo pré-contato. |
| `apps/api/src/modules/lead-insights/insight-prompt.spec.ts` | Testes do prompt. |
| `apps/api/src/modules/lead-insights/lead-insights.service.ts` | Select ampliado, cadastro, geração sem mensagens, `enfileirarImportado`. |
| `apps/api/src/modules/lead-insights/lead-insights.service.spec.ts` | Testes novos. |
| `docker-compose.yml`, `.env.example`, `CLAUDE.md` | Envs novas documentadas e repassadas ao container. |

---

### Task 1: Parser — CSV, telefone, classificação e linha de teste

**Files:**
- Create: `apps/api/src/modules/sheet-import/sheet-import.parser.ts`
- Test: `apps/api/src/modules/sheet-import/sheet-import.parser.spec.ts`

**Interfaces:**
- Produces:
  - `parseCsv(text: string): Record<string, string>[]` — cada linha vira objeto `{header: valor}`; ordem das chaves = ordem das colunas.
  - `normalizePhone(raw: string): string | null`
  - `type CompanyType = 'MEI' | 'ME_LTDA' | 'PESSOA_FISICA' | 'NAO_INFORMADO'`
  - `COMPANY_TYPE_LABEL: Record<CompanyType, string>` = `{ MEI: 'MEI', ME_LTDA: 'ME/LTDA', PESSOA_FISICA: 'Pessoa Física', NAO_INFORMADO: 'Não informado' }`
  - `classifyCompanyType(raw: string): CompanyType`
  - `isTestRow(row: Record<string, string>): boolean`

- [ ] **Step 1: Escrever os testes que falham**

```ts
// apps/api/src/modules/sheet-import/sheet-import.parser.spec.ts
import {
  classifyCompanyType,
  isTestRow,
  normalizePhone,
  parseCsv,
} from './sheet-import.parser';

describe('parseCsv', () => {
  it('separa colunas, respeita aspas com vírgula interna e CRLF', () => {
    const csv = 'id,nome,cidade\r\nl:1,"Silva, João",Curitiba\r\nl:2,Maria,"São José dos Pinhais"\r\n';
    expect(parseCsv(csv)).toEqual([
      { id: 'l:1', nome: 'Silva, João', cidade: 'Curitiba' },
      { id: 'l:2', nome: 'Maria', cidade: 'São José dos Pinhais' },
    ]);
  });

  it('aspas duplicadas dentro de aspas viram uma aspa', () => {
    expect(parseCsv('a,b\n"x ""y"" z",1\n')).toEqual([{ a: 'x "y" z', b: '1' }]);
  });

  it('linha vazia no fim é ignorada e coluna faltante vira string vazia', () => {
    expect(parseCsv('a,b,c\n1,2\n\n')).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('preserva a ordem das colunas nas chaves do objeto', () => {
    const [row] = parseCsv('z,a,m\n1,2,3\n');
    expect(Object.keys(row)).toEqual(['z', 'a', 'm']);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['p:+5519997094696', '5519997094696'],
    ['p:11945550754', '5511945550754'],
    ['p:+554797887666', '554797887666'],
    ['(41) 99293-8568', '5541992938568'],
    ['5541992938568', '5541992938568'],
  ])('%s -> %s', (raw, esperado) => {
    expect(normalizePhone(raw)).toBe(esperado);
  });

  it.each([['p:<test lead: dummy data for Telefone>'], [''], ['123'], ['p:+1 555 0100']])(
    'inválido %s -> null',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );
});

describe('classifyCompanyType', () => {
  it.each([
    ['Ltda', 'ME_LTDA'],
    ['LTDA', 'ME_LTDA'],
    ['lTDA', 'ME_LTDA'],
    ['ME', 'ME_LTDA'],
    ['Mei e LTDA', 'ME_LTDA'],
    ['Limitada', 'ME_LTDA'],
    ['Mei', 'MEI'],
    ['MEI', 'MEI'],
    ['mei', 'MEI'],
    ['Pessoa Física', 'PESSOA_FISICA'],
    ['Ainda não tenho empresa', 'PESSOA_FISICA'],
    ['Autônomo', 'PESSOA_FISICA'],
    ['Sim', 'NAO_INFORMADO'],
    ['Meu', 'NAO_INFORMADO'],
    ['Outro', 'NAO_INFORMADO'],
    ['', 'NAO_INFORMADO'],
  ])('%s -> %s', (raw, esperado) => {
    expect(classifyCompanyType(raw)).toBe(esperado);
  });
});

describe('isTestRow', () => {
  it('detecta linha de teste do Meta pelo nome, telefone ou e-mail', () => {
    expect(
      isTestRow({ 'Nome Completo': '<test lead: dummy data for Nome Completo>', Telefone: 'p:1', Email: 'x' }),
    ).toBe(true);
    expect(isTestRow({ 'Nome Completo': 'A', Telefone: 'p:<test lead: dummy data for Telefone>', Email: 'x' })).toBe(true);
    expect(isTestRow({ 'Nome Completo': 'A', Telefone: 'p:1', Email: 'test@meta.com' })).toBe(true);
  });

  it('linha real não é teste', () => {
    expect(isTestRow({ 'Nome Completo': 'Eduardo jr - Deka', Telefone: 'p:+5519997094696', Email: 'a@b.com' })).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.parser.spec.ts`
Expected: FAIL — `Cannot find module './sheet-import.parser'`.

- [ ] **Step 3: Implementar**

```ts
// apps/api/src/modules/sheet-import/sheet-import.parser.ts
/**
 * Parser da planilha do Meta Lead Ads (export padrão do Google Sheets).
 *
 * Funções puras: sem Nest, sem Prisma, sem rede. O service só orquestra.
 * Ver docs/superpowers/specs/2026-09-08-importacao-planilha-meta-design.md.
 */

export type CompanyType = 'MEI' | 'ME_LTDA' | 'PESSOA_FISICA' | 'NAO_INFORMADO';

export const COMPANY_TYPE_LABEL: Record<CompanyType, string> = {
  MEI: 'MEI',
  ME_LTDA: 'ME/LTDA',
  PESSOA_FISICA: 'Pessoa Física',
  NAO_INFORMADO: 'Não informado',
};

/** CSV RFC 4180 simples: aspas, vírgula dentro de aspas, aspas duplicadas, CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let entreAspas = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (entreAspas) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          entreAspas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"') {
      entreAspas = true;
    } else if (c === ',') {
      linha.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      linha.push(campo);
      campo = '';
      linhas.push(linha);
      linha = [];
    } else {
      campo += c;
    }
  }
  if (campo !== '' || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }

  const [header, ...corpo] = linhas.filter((l) => !(l.length === 1 && l[0] === ''));
  if (!header) return [];
  return corpo.map((valores) => {
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = valores[idx] ?? '';
    });
    return row;
  });
}

/**
 * Só dígitos, com DDI 55 — o mesmo formato que o inbound grava em
 * `Lead.telefone`, senão o dedupe por telefone não encontra o card.
 */
export function normalizePhone(raw: string): string | null {
  const digitos = raw.replace(/\D/g, '');
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) return digitos;
  return null;
}

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * A pergunta "sua empresa é MEI ou LTDA?" é texto livre. A ordem das regras é
 * decisão de produto: quem cita empresa limitada é ME_LTDA mesmo que também
 * fale em MEI ("Mei e LTDA").
 */
export function classifyCompanyType(raw: string): CompanyType {
  const s = semAcento(raw);
  if (s === '') return 'NAO_INFORMADO';
  if (/\bltda\b|limitada|eireli|\bs\/?a\b|\bme\b/.test(s)) return 'ME_LTDA';
  if (/\bmei\b/.test(s)) return 'MEI';
  if (/pessoa f|fisica|nao tenho|autonom|\bcpf\b/.test(s)) return 'PESSOA_FISICA';
  return 'NAO_INFORMADO';
}

const MARCA_TESTE = '<test lead';

/** Linha de teste que o Meta gera ao publicar o formulário. */
export function isTestRow(row: Record<string, string>): boolean {
  if ((row.Email ?? '').trim().toLowerCase() === 'test@meta.com') return true;
  return Object.values(row).some((v) => v.includes(MARCA_TESTE));
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.parser.spec.ts`
Expected: PASS, todos os `it`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sheet-import/sheet-import.parser.ts apps/api/src/modules/sheet-import/sheet-import.parser.spec.ts
git commit -m "feat(api): parser da planilha Meta Lead Ads — csv, telefone, classificacao MEI"
```

---

### Task 2: Parser — `mapRow` (linha → lead importado)

**Files:**
- Create: `apps/api/src/modules/sheet-import/sheet-import.fields.ts`
- Modify: `apps/api/src/modules/sheet-import/sheet-import.parser.ts`
- Test: `apps/api/src/modules/sheet-import/sheet-import.parser.spec.ts`

**Interfaces:**
- Consumes: `normalizePhone`, `classifyCompanyType`, `isTestRow`, `COMPANY_TYPE_LABEL` (Task 1).
- Produces:
  - `IMPORT_GROUP_NAME = 'Formulário Meta'`
  - `IMPORT_FIELDS: ReadonlyArray<ImportFieldSpec>` com `{ key, nome, tipo: 'text' | 'select' | 'date', options?, ordem }`
  - `interface ImportedLead { sourceRowId: string; nome: string; telefone: string; email: string | null; dadosCustom: Record<string, string>; tags: string[]; attribution: Record<string, string>; atividadeTexto: string; companyType: CompanyType }`
  - `type MapResult = { ok: true; lead: ImportedLead } | { ok: false; motivo: string }`
  - `mapRow(row: Record<string, string>): MapResult`

- [ ] **Step 1: Criar o catálogo de campos**

```ts
// apps/api/src/modules/sheet-import/sheet-import.fields.ts
import { COMPANY_TYPE_LABEL } from './sheet-import.parser';

export const IMPORT_GROUP_NAME = 'Formulário Meta';

export interface ImportFieldSpec {
  key: string;
  nome: string;
  tipo: 'text' | 'select' | 'date';
  options?: string[];
  ordem: number;
}

/**
 * Definições de campo custom (escopo LEAD) que a importação garante no tenant.
 * Chaves são estáveis: são elas que entram em `Lead.dados_custom`.
 */
export const IMPORT_FIELDS: ReadonlyArray<ImportFieldSpec> = [
  {
    key: 'tipo_empresa',
    nome: 'Tipo de empresa',
    tipo: 'select',
    options: Object.values(COMPANY_TYPE_LABEL),
    ordem: 0,
  },
  { key: 'tipo_empresa_resposta', nome: 'Resposta original (MEI/LTDA)', tipo: 'text', ordem: 1 },
  { key: 'anos_consorcio', nome: 'Anos com consórcio', tipo: 'text', ordem: 2 },
  { key: 'estrutura_fisica', nome: 'Estrutura física', tipo: 'text', ordem: 3 },
  { key: 'qtd_vendedores', nome: 'Quantidade de vendedores', tipo: 'text', ordem: 4 },
  { key: 'producao_mensal', nome: 'Produção mensal', tipo: 'text', ordem: 5 },
  { key: 'cidade', nome: 'Cidade', tipo: 'text', ordem: 6 },
  { key: 'estado', nome: 'Estado', tipo: 'text', ordem: 7 },
  { key: 'form_data', nome: 'Data do formulário', tipo: 'date', ordem: 8 },
];
```

- [ ] **Step 2: Escrever os testes de `mapRow` que falham**

Acrescentar ao spec:

```ts
import { mapRow } from './sheet-import.parser';

const LINHA_REAL: Record<string, string> = {
  id: 'l:1464784368803570',
  created_time: '2026-09-04T11:17:13-05:00',
  ad_id: 'ag:52542418411334',
  ad_name: '02',
  adset_id: 'as:52542418412334',
  adset_name: '[Brasilia/Goiania/SãoPaulo] [PI + PA] [ADV]',
  campaign_id: 'c:52542418410934',
  campaign_name: '[LEADS] [WHATSAPP] [Parcerias PL Master] [+LEADS] V3',
  form_id: 'f:1020102430402581',
  form_name: 'Formulário PL Master',
  is_organic: 'false',
  platform: 'ig',
  'há_quantos_anos_na_atua_com_vendas_de_consórcio?': '3 anos',
  'possui_estrutura_física?': 'Não',
  'tem_quantos_vendedores?': '1',
  'média_de_produção_mensal?': '500 mil',
  'sua_empresa_é_mei_ou_ltda?': 'Mei',
  Email: 'joseeduardojunior56@gmail.com',
  'Nome Completo': 'Eduardo jr - Deka',
  Telefone: 'p:+5519997094696',
  Cidade: 'Paulínia',
  estado: 'SP',
  lead_status: 'CREATED',
};

describe('mapRow', () => {
  it('linha real vira lead com campos, tag MEI, atribuição e texto da atividade', () => {
    const r = mapRow(LINHA_REAL);
    if (!r.ok) throw new Error(r.motivo);
    expect(r.lead.sourceRowId).toBe('l:1464784368803570');
    expect(r.lead.nome).toBe('Eduardo jr - Deka');
    expect(r.lead.telefone).toBe('5519997094696');
    expect(r.lead.email).toBe('joseeduardojunior56@gmail.com');
    expect(r.lead.companyType).toBe('MEI');
    expect(r.lead.tags).toEqual(['MEI']);
    expect(r.lead.dadosCustom).toEqual({
      tipo_empresa: 'MEI',
      tipo_empresa_resposta: 'Mei',
      anos_consorcio: '3 anos',
      estrutura_fisica: 'Não',
      qtd_vendedores: '1',
      producao_mensal: '500 mil',
      cidade: 'Paulínia',
      estado: 'SP',
      form_data: '2026-09-04',
    });
    expect(r.lead.attribution).toEqual({
      utm_source: 'ig',
      utm_medium: 'paid',
      utm_campaign: '[LEADS] [WHATSAPP] [Parcerias PL Master] [+LEADS] V3',
      campaignid: '52542418410934',
      adgroupid: '52542418412334',
      creative: '52542418411334',
    });
    expect(r.lead.atividadeTexto).toBe(
      'Tipo de empresa: MEI (Mei) · Anos com consórcio: 3 anos · Estrutura física: Não · Quantidade de vendedores: 1 · Produção mensal: 500 mil · Paulínia/SP · Campanha: [LEADS] [WHATSAPP] [Parcerias PL Master] [+LEADS] V3 · Conjunto: [Brasilia/Goiania/SãoPaulo] [PI + PA] [ADV] · Anúncio: 02',
    );
  });

  it('pessoa física recebe tag "Pessoa Física"; LTDA e não informado não recebem tag', () => {
    const pf = mapRow({ ...LINHA_REAL, 'sua_empresa_é_mei_ou_ltda?': 'Pessoa Física' });
    const ltda = mapRow({ ...LINHA_REAL, 'sua_empresa_é_mei_ou_ltda?': 'Ltda' });
    const sim = mapRow({ ...LINHA_REAL, 'sua_empresa_é_mei_ou_ltda?': 'Sim' });
    expect(pf.ok && pf.lead.tags).toEqual(['Pessoa Física']);
    expect(ltda.ok && ltda.lead.tags).toEqual([]);
    expect(sim.ok && sim.lead.tags).toEqual([]);
    expect(sim.ok && sim.lead.dadosCustom.tipo_empresa).toBe('Não informado');
  });

  it('e-mail inválido vira null, nome vazio vira o telefone', () => {
    const r = mapRow({ ...LINHA_REAL, Email: 'sem-arroba', 'Nome Completo': '  ' });
    expect(r.ok && r.lead.email).toBeNull();
    expect(r.ok && r.lead.nome).toBe('5519997094696');
  });

  it('linha de teste do Meta é pulada com motivo', () => {
    const r = mapRow({ ...LINHA_REAL, 'Nome Completo': '<test lead: dummy data for Nome Completo>' });
    expect(r).toEqual({ ok: false, motivo: 'linha de teste do Meta' });
  });

  it('telefone inválido é pulado com motivo', () => {
    const r = mapRow({ ...LINHA_REAL, Telefone: 'p:+1 555 0100' });
    expect(r).toEqual({ ok: false, motivo: 'telefone inválido: p:+1 555 0100' });
  });

  it('sem id da linha é pulada', () => {
    expect(mapRow({ ...LINHA_REAL, id: '' })).toEqual({ ok: false, motivo: 'linha sem id' });
  });

  it('orgânico vira utm_medium organic e plataforma vazia vira meta', () => {
    const r = mapRow({ ...LINHA_REAL, is_organic: 'true', platform: '' });
    expect(r.ok && r.lead.attribution.utm_medium).toBe('organic');
    expect(r.ok && r.lead.attribution.utm_source).toBe('meta');
  });

  it('pergunta renomeada é achada por posição entre platform e Email', () => {
    // Reconstrói mantendo a posição: a coluna renomeada fica onde estava.
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(LINHA_REAL)) {
      row[k === 'há_quantos_anos_na_atua_com_vendas_de_consórcio?' ? 'quantos_anos_de_consorcio?' : k] = v;
    }
    const r = mapRow(row);
    expect(r.ok && r.lead.dadosCustom.anos_consorcio).toBe('3 anos');
  });

  it('pergunta extra desconhecida entra só no texto da atividade', () => {
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(LINHA_REAL)) {
      row[k] = v;
      if (k === 'sua_empresa_é_mei_ou_ltda?') row['qual_seu_faturamento?'] = '1 milhão';
    }
    const r = mapRow(row);
    expect(r.ok && r.lead.dadosCustom).not.toHaveProperty('qual_seu_faturamento?');
    expect(r.ok && r.lead.atividadeTexto).toContain('qual seu faturamento: 1 milhão');
  });

  it('data do formulário é convertida para AAAA-MM-DD em horário de Brasília', () => {
    // 23:30 em -05:00 = 01:30 do dia seguinte em -03:00.
    const r = mapRow({ ...LINHA_REAL, created_time: '2026-09-04T23:30:00-05:00' });
    expect(r.ok && r.lead.dadosCustom.form_data).toBe('2026-09-05');
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.parser.spec.ts -t mapRow`
Expected: FAIL — `mapRow is not a function` (ou import ausente).

- [ ] **Step 4: Implementar `mapRow`**

Acrescentar ao fim de `sheet-import.parser.ts`:

```ts
export interface ImportedLead {
  sourceRowId: string;
  nome: string;
  telefone: string;
  email: string | null;
  companyType: CompanyType;
  /** Chaves de IMPORT_FIELDS; só as que têm valor. */
  dadosCustom: Record<string, string>;
  tags: string[];
  /** Formato de `attributionInputSchema` (attribution.types.ts). Só chaves com valor. */
  attribution: Record<string, string>;
  atividadeTexto: string;
}

export type MapResult = { ok: true; lead: ImportedLead } | { ok: false; motivo: string };

/** Colunas fixas do export do Meta. As perguntas do formulário ficam entre `platform` e `Email`. */
const COL = {
  id: 'id',
  createdTime: 'created_time',
  adId: 'ad_id',
  adName: 'ad_name',
  adsetId: 'adset_id',
  adsetName: 'adset_name',
  campaignId: 'campaign_id',
  campaignName: 'campaign_name',
  isOrganic: 'is_organic',
  platform: 'platform',
  email: 'Email',
  nome: 'Nome Completo',
  telefone: 'Telefone',
  cidade: 'Cidade',
  estado: 'estado',
} as const;

/** Perguntas conhecidas: header exato → chave do campo custom. Ordem = posição no formulário. */
const PERGUNTAS: ReadonlyArray<{ header: string; key: string; rotulo: string }> = [
  { header: 'há_quantos_anos_na_atua_com_vendas_de_consórcio?', key: 'anos_consorcio', rotulo: 'Anos com consórcio' },
  { header: 'possui_estrutura_física?', key: 'estrutura_fisica', rotulo: 'Estrutura física' },
  { header: 'tem_quantos_vendedores?', key: 'qtd_vendedores', rotulo: 'Quantidade de vendedores' },
  { header: 'média_de_produção_mensal?', key: 'producao_mensal', rotulo: 'Produção mensal' },
  { header: 'sua_empresa_é_mei_ou_ltda?', key: 'tipo_empresa_resposta', rotulo: 'Tipo de empresa' },
];

const EMAIL_SIMPLES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

function limpo(v: string | undefined): string {
  return (v ?? '').trim();
}

/** Tira o prefixo do Meta (`c:`, `as:`, `ag:`, `l:`), fica só o número. */
function semPrefixo(v: string): string {
  return limpo(v).replace(/^[a-z]+:/, '');
}

/** `created_time` ISO com offset → `AAAA-MM-DD` no fuso de Brasília. */
function dataBrt(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Header em texto legível: tira `_`, `?` e capitaliza nada (fica como pergunta). */
function headerLegivel(h: string): string {
  return h.replace(/_/g, ' ').replace(/\?$/, '').trim();
}

/**
 * Perguntas do formulário: por header exato; se a agência renomeou a pergunta,
 * pela posição relativa entre `platform` e `Email`. Perguntas que não batem
 * com nenhuma conhecida voltam em `extras` (vão só para o texto da atividade).
 */
function respostas(row: Record<string, string>): {
  porKey: Record<string, string>;
  extras: Array<{ rotulo: string; valor: string }>;
} {
  const headers = Object.keys(row);
  const ini = headers.indexOf(COL.platform);
  const fim = headers.indexOf(COL.email);
  const faixa = ini >= 0 && fim > ini ? headers.slice(ini + 1, fim) : [];

  const porKey: Record<string, string> = {};
  const usados = new Set<string>();
  PERGUNTAS.forEach((p, idx) => {
    let header: string | undefined = headers.includes(p.header) ? p.header : undefined;
    if (header === undefined && faixa[idx] !== undefined && !PERGUNTAS.some((q) => q.header === faixa[idx])) {
      header = faixa[idx];
    }
    if (header === undefined) return;
    usados.add(header);
    const v = limpo(row[header]);
    if (v !== '') porKey[p.key] = v;
  });

  const extras = faixa
    .filter((h) => !usados.has(h))
    .map((h) => ({ rotulo: headerLegivel(h), valor: limpo(row[h]) }))
    .filter((e) => e.valor !== '');

  return { porKey, extras };
}

export function mapRow(row: Record<string, string>): MapResult {
  const sourceRowId = limpo(row[COL.id]);
  if (sourceRowId === '') return { ok: false, motivo: 'linha sem id' };
  if (isTestRow(row)) return { ok: false, motivo: 'linha de teste do Meta' };

  const telefoneCru = limpo(row[COL.telefone]);
  const telefone = normalizePhone(telefoneCru);
  if (telefone === null) return { ok: false, motivo: `telefone inválido: ${telefoneCru}` };

  const nome = limpo(row[COL.nome]) || telefone;
  const emailCru = limpo(row[COL.email]);
  const email = EMAIL_SIMPLES.test(emailCru) ? emailCru : null;

  const { porKey, extras } = respostas(row);
  const respostaTipo = porKey.tipo_empresa_resposta ?? '';
  const companyType = classifyCompanyType(respostaTipo);

  const dadosCustom: Record<string, string> = {
    tipo_empresa: COMPANY_TYPE_LABEL[companyType],
    ...porKey,
  };
  const cidade = limpo(row[COL.cidade]);
  const estado = limpo(row[COL.estado]);
  if (cidade !== '') dadosCustom.cidade = cidade;
  if (estado !== '') dadosCustom.estado = estado;
  const formData = dataBrt(limpo(row[COL.createdTime]));
  if (formData !== null) dadosCustom.form_data = formData;

  const tags: string[] = [];
  if (companyType === 'MEI') tags.push('MEI');
  if (companyType === 'PESSOA_FISICA') tags.push('Pessoa Física');

  const organico = limpo(row[COL.isOrganic]).toLowerCase() === 'true';
  const attribution: Record<string, string> = {
    utm_source: limpo(row[COL.platform]).toLowerCase() || 'meta',
    utm_medium: organico ? 'organic' : 'paid',
  };
  const campaignName = limpo(row[COL.campaignName]);
  const campaignId = semPrefixo(row[COL.campaignId] ?? '');
  const adsetId = semPrefixo(row[COL.adsetId] ?? '');
  const adId = semPrefixo(row[COL.adId] ?? '');
  if (campaignName !== '') attribution.utm_campaign = campaignName;
  if (campaignId !== '') attribution.campaignid = campaignId;
  if (adsetId !== '') attribution.adgroupid = adsetId;
  if (adId !== '') attribution.creative = adId;

  const partes: string[] = [];
  partes.push(
    respostaTipo !== ''
      ? `Tipo de empresa: ${COMPANY_TYPE_LABEL[companyType]} (${respostaTipo})`
      : `Tipo de empresa: ${COMPANY_TYPE_LABEL[companyType]}`,
  );
  for (const p of PERGUNTAS) {
    if (p.key === 'tipo_empresa_resposta') continue;
    const v = porKey[p.key];
    if (v !== undefined) partes.push(`${p.rotulo}: ${v}`);
  }
  for (const e of extras) partes.push(`${e.rotulo}: ${e.valor}`);
  if (cidade !== '' || estado !== '') partes.push([cidade, estado].filter((s) => s !== '').join('/'));
  if (campaignName !== '') partes.push(`Campanha: ${campaignName}`);
  const adsetName = limpo(row[COL.adsetName]);
  if (adsetName !== '') partes.push(`Conjunto: ${adsetName}`);
  const adName = limpo(row[COL.adName]);
  if (adName !== '') partes.push(`Anúncio: ${adName}`);

  return {
    ok: true,
    lead: {
      sourceRowId,
      nome,
      telefone,
      email,
      companyType,
      dadosCustom,
      tags,
      attribution,
      atividadeTexto: partes.join(' · '),
    },
  };
}
```

Atenção ao import circular: `sheet-import.fields.ts` importa `COMPANY_TYPE_LABEL` do parser; o parser NÃO importa `fields`. Mantém assim.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.parser.spec.ts`
Expected: PASS. Se o teste de "pergunta renomeada" falhar, conferir que `faixa[idx]` está alinhado: índice 0 da faixa = primeira pergunta.

- [ ] **Step 6: Typecheck e commit**

Run: `cd apps/api && npm run typecheck`
Expected: sem erros.

```bash
git add apps/api/src/modules/sheet-import/
git commit -m "feat(api): mapRow — linha da planilha Meta vira lead com campos, tags e atribuicao"
```

---

### Task 3: Model `SheetImportRow`, migration aditiva e script aplicador

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (após o model `LeadAttribution`, ~linha 1340)
- Create: `apps/api/prisma/migrations/20260908120000_sheet_import_row/migration.sql`
- Create: `apps/api/scripts/apply-sheet-import.mjs`

**Interfaces:**
- Produces: `prisma.sheetImportRow` com campos `id, tenant_id, source_row_id, lead_id, status, detail, attempts, created_at, updated_at`; unique `tenant_id_source_row_id`.

- [ ] **Step 1: Model no schema**

```prisma
// Registro de linha da planilha Meta Lead Ads já vista pela importação
// (modules/sheet-import). Dedupe por (tenant, id da linha no Meta).
// Sem FK para Lead/Tenant de propósito: nenhum ALTER em tabela existente —
// mesmo compromisso de LeadAttribution e ApiRequestLog.
// status: 'ok' (lead criado ou anexado) | 'skipped' (teste/telefone inválido) | 'error'.
model SheetImportRow {
  id            String   @id @default(uuid())
  tenant_id     String
  source_row_id String
  lead_id       String?
  status        String
  detail        String?
  attempts      Int      @default(1)
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  @@unique([tenant_id, source_row_id])
  @@index([tenant_id, status])
}
```

- [ ] **Step 2: Gerar o SQL de referência e conferir**

Run (cwd `apps/api`, com `.env` local carregado — o script lê DATABASE_URL):

```bash
node ../../node_modules/prisma/build/index.js migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > /tmp/diff.sql; grep -n "SheetImportRow" /tmp/diff.sql
```

Expected: só `CREATE TABLE "SheetImportRow"`, `CREATE UNIQUE INDEX`, `CREATE INDEX`. Ignorar qualquer outro statement (é o drift pré-existente descrito no CLAUDE.md; NÃO copiar).

- [ ] **Step 3: Escrever a migration à mão**

```sql
-- apps/api/prisma/migrations/20260908120000_sheet_import_row/migration.sql
-- Importação da planilha Meta Lead Ads: registro de linha já vista.
-- ADITIVO E SÓ: uma tabela nova, sem FK. NENHUM ALTER em tabela existente.
-- Ver docs/superpowers/specs/2026-09-08-importacao-planilha-meta-design.md.
--
-- Aplicar com:  node scripts/apply-sheet-import.mjs   (cwd = apps/api)
-- As linhas "-- @@SPLIT" separam os statements para o script aplicador.

CREATE TABLE IF NOT EXISTS "SheetImportRow" (
  "id"            TEXT NOT NULL,
  "tenant_id"     TEXT NOT NULL,
  "source_row_id" TEXT NOT NULL,
  "lead_id"       TEXT,
  "status"        TEXT NOT NULL,
  "detail"        TEXT,
  "attempts"      INTEGER NOT NULL DEFAULT 1,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SheetImportRow_pkey" PRIMARY KEY ("id")
);
-- @@SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "SheetImportRow_tenant_id_source_row_id_key"
  ON "SheetImportRow"("tenant_id", "source_row_id");
-- @@SPLIT
CREATE INDEX IF NOT EXISTS "SheetImportRow_tenant_id_status_idx"
  ON "SheetImportRow"("tenant_id", "status");
```

- [ ] **Step 4: Script aplicador**

Copiar `apps/api/scripts/apply-attribution.mjs` para `apps/api/scripts/apply-sheet-import.mjs` e trocar:
- `SQL_PATH`: pasta `20260908120000_sheet_import_row`.
- `TABELAS_NOVAS = ['SheetImportRow']`.
- Cabeçalho do comentário: "aplica 20260908120000_sheet_import_row (SheetImportRow)".
- Mensagem final: `migrate resolve --applied 20260908120000_sheet_import_row`.

Todo o resto (gate de segurança contra ALTER em tabela existente, contagem antes/depois de Lead/Tenant/Message, `--dry-run`, exigência de `DIRECT_URL:5432`, transação tudo-ou-nada) fica igual.

- [ ] **Step 5: Gerar o client e checar tipos**

Run: `cd apps/api && node ../../node_modules/prisma/build/index.js generate && npm run typecheck`
Expected: `Generated Prisma Client`, typecheck sem erros. `prisma.sheetImportRow` passa a existir.

- [ ] **Step 6: Dry-run local contra o banco**

Run: `cd apps/api && node --env-file=.env scripts/apply-sheet-import.mjs --dry-run`
Expected: `ANTES: { Lead: N, Tenant: N, Message: N, SheetImportRow: null }` e `--dry-run: nada foi aplicado.` Não aplicar ainda: a aplicação real é passo do deploy (Task 10).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260908120000_sheet_import_row/migration.sql apps/api/scripts/apply-sheet-import.mjs
git commit -m "feat(api): tabela SheetImportRow (dedupe por linha da planilha) + aplicador aditivo"
```

---

### Task 4: `CustomFieldsService.ensureTenantBootstrap` público

**Files:**
- Modify: `apps/api/src/modules/leads/custom-fields.service.ts:106`

**Interfaces:**
- Produces: `ensureTenantBootstrap(tenantId: string): Promise<void>` — idempotente; cria grupo "Principal" e campos nativos se o tenant ainda não tem nenhum grupo.

- [ ] **Step 1: Renomear e tornar público**

Em `custom-fields.service.ts`, trocar `private async ensureBootstrap(tenantId: string)` por `async ensureTenantBootstrap(tenantId: string)` e atualizar todas as chamadas internas (`this.ensureBootstrap(` → `this.ensureTenantBootstrap(`). Adicionar docblock:

```ts
  /**
   * Garante grupo "Principal" + campos nativos do tenant. Idempotente. Público
   * porque a importação de planilha (modules/sheet-import) cria definições de
   * campo por baixo da UI e precisa do bootstrap feito antes.
   */
```

Run: `cd apps/api && grep -n "ensureBootstrap" src/modules/leads/custom-fields.service.ts`
Expected: nenhuma ocorrência.

- [ ] **Step 2: Testes existentes seguem passando**

Run: `cd apps/api && npx jest src/modules/leads/custom-fields-bootstrap.spec.ts src/modules/public-api/public-api-custom-fields.spec.ts`
Expected: PASS. Se algum spec chamar `ensureBootstrap` via cast, renomear lá também.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/leads/
git commit -m "refactor(api): CustomFieldsService.ensureTenantBootstrap publico para a importacao"
```

---

### Task 5: `SheetImportService` — config, contexto e `ensureFieldDefs`

**Files:**
- Create: `apps/api/src/modules/sheet-import/sheet-import.service.ts`
- Create: `apps/api/src/modules/sheet-import/sheet-import.module.ts`
- Test: `apps/api/src/modules/sheet-import/sheet-import.service.spec.ts`

**Interfaces:**
- Consumes: `IMPORT_FIELDS`, `IMPORT_GROUP_NAME` (Task 2); `CustomFieldsService.ensureTenantBootstrap` (Task 4); `prisma.sheetImportRow` (Task 3).
- Produces:
  - `class SheetImportService` com construtor `(prisma: PrismaService, config: ConfigService, customFields: CustomFieldsService, attribution: AttributionService, gateway: CrmGateway, insights: LeadInsightsService)`.
  - `isEnabled(): boolean`
  - `ensureFieldDefs(tenantId: string): Promise<void>`
  - `resolveContext(): Promise<RunContext>` onde `interface RunContext { tenantId: string; pipelineId: string; stageId: string; instancia: string }`
  - Ainda sem `run()`/`processRow()` (Tasks 6 e 7).

- [ ] **Step 1: Testes que falham**

```ts
// apps/api/src/modules/sheet-import/sheet-import.service.spec.ts
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CustomFieldsService } from '../leads/custom-fields.service';
import type { AttributionService } from '../attribution/attribution.service';
import type { CrmGateway } from '../websocket/websocket.gateway';
import type { LeadInsightsService } from '../lead-insights/lead-insights.service';
import { SheetImportService } from './sheet-import.service';
import { IMPORT_FIELDS, IMPORT_GROUP_NAME } from './sheet-import.fields';

/**
 * Mocks na borda (Prisma, config, serviços vizinhos, fetch). O service é
 * exercitado de verdade. Sem `any`: cast uma vez no construtor.
 */
export function montar(env: Record<string, string | undefined> = {}) {
  const prisma = {
    customFieldGroup: { findFirst: jest.fn(), create: jest.fn() },
    customFieldDef: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    pipeline: { findFirst: jest.fn() },
    stage: { findFirst: jest.fn() },
    whatsappInstance: { findFirst: jest.fn() },
    sheetImportRow: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    lead: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    leadActivity: { create: jest.fn() },
    tag: { upsert: jest.fn() },
    leadTag: { createMany: jest.fn() },
    $transaction: jest.fn(),
  };
  // $transaction interativo: executa o callback com o próprio mock como tx.
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));

  const config = { get: jest.fn((k: string, d?: string) => env[k] ?? d) };
  const customFields = {
    ensureTenantBootstrap: jest.fn().mockResolvedValue(undefined),
    validateValues: jest.fn(async (v: Record<string, unknown>) => v),
  };
  const attribution = { recordFirstTouch: jest.fn().mockResolvedValue(undefined) };
  const gateway = { emitLeadCreated: jest.fn() };
  const insights = { enfileirarImportado: jest.fn().mockResolvedValue(undefined) };

  const service = new SheetImportService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    customFields as unknown as CustomFieldsService,
    attribution as unknown as AttributionService,
    gateway as unknown as CrmGateway,
    insights as unknown as LeadInsightsService,
  );
  return { service, prisma, config, customFields, attribution, gateway, insights };
}

const ENV_OK = {
  SHEET_IMPORT_TENANT_ID: 't1',
  SHEET_IMPORT_SHEET_ID: 'sheet-abc',
};

describe('SheetImportService config', () => {
  it('sem SHEET_IMPORT_TENANT_ID/SHEET_ID fica inerte', () => {
    expect(montar({}).service.isEnabled()).toBe(false);
    expect(montar({ SHEET_IMPORT_TENANT_ID: 't1' }).service.isEnabled()).toBe(false);
    expect(montar(ENV_OK).service.isEnabled()).toBe(true);
  });
});

describe('SheetImportService.resolveContext', () => {
  it('sem pipeline/stage na env usa primeiro pipeline, primeira etapa base e instância mais recente', async () => {
    const m = montar(ENV_OK);
    m.prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1' });
    m.prisma.stage.findFirst.mockResolvedValue({ id: 's1' });
    m.prisma.whatsappInstance.findFirst.mockResolvedValue({ nome: 'leads' });

    await expect(m.service.resolveContext()).resolves.toEqual({
      tenantId: 't1',
      pipelineId: 'p1',
      stageId: 's1',
      instancia: 'leads',
    });
    expect(m.prisma.stage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pipeline_id: 'p1', tenant_id: 't1', user_id: null } }),
    );
  });

  it('env com pipeline e stage explícitos vence', async () => {
    const m = montar({ ...ENV_OK, SHEET_IMPORT_PIPELINE_ID: 'pX', SHEET_IMPORT_STAGE_ID: 'sX' });
    m.prisma.whatsappInstance.findFirst.mockResolvedValue(null);
    const ctx = await m.service.resolveContext();
    expect(ctx).toEqual({ tenantId: 't1', pipelineId: 'pX', stageId: 'sX', instancia: '' });
    expect(m.prisma.pipeline.findFirst).not.toHaveBeenCalled();
  });

  it('tenant sem pipeline lança erro claro', async () => {
    const m = montar(ENV_OK);
    m.prisma.pipeline.findFirst.mockResolvedValue(null);
    await expect(m.service.resolveContext()).rejects.toThrow('sem pipeline');
  });
});

describe('SheetImportService.ensureFieldDefs', () => {
  it('cria grupo e só as definições que faltam', async () => {
    const m = montar(ENV_OK);
    m.prisma.customFieldGroup.findFirst.mockResolvedValue(null);
    m.prisma.customFieldGroup.create.mockResolvedValue({ id: 'g1' });
    m.prisma.customFieldDef.findMany.mockResolvedValue([{ key: 'cidade' }, { key: 'estado' }]);

    await m.service.ensureFieldDefs('t1');

    expect(m.customFields.ensureTenantBootstrap).toHaveBeenCalledWith('t1');
    expect(m.prisma.customFieldGroup.create).toHaveBeenCalledWith({
      data: { tenant_id: 't1', escopo: 'LEAD', nome: IMPORT_GROUP_NAME, ordem: 10 },
    });
    const [{ data }] = m.prisma.customFieldDef.createMany.mock.calls[0] as [{ data: Array<{ key: string }> }];
    const keys = data.map((d) => d.key);
    expect(keys).toEqual(IMPORT_FIELDS.map((f) => f.key).filter((k) => k !== 'cidade' && k !== 'estado'));
    expect(data.every((d) => 'group_id' in d && (d as { group_id: string }).group_id === 'g1')).toBe(true);
  });

  it('grupo já existente é reaproveitado e nada é criado se todas as chaves existem', async () => {
    const m = montar(ENV_OK);
    m.prisma.customFieldGroup.findFirst.mockResolvedValue({ id: 'g-existente' });
    m.prisma.customFieldDef.findMany.mockResolvedValue(IMPORT_FIELDS.map((f) => ({ key: f.key })));

    await m.service.ensureFieldDefs('t1');

    expect(m.prisma.customFieldGroup.create).not.toHaveBeenCalled();
    expect(m.prisma.customFieldDef.createMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.service.spec.ts`
Expected: FAIL — módulo `./sheet-import.service` não existe.

- [ ] **Step 3: Implementar service (parte 1) e módulo**

```ts
// apps/api/src/modules/sheet-import/sheet-import.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomFieldsService } from '../leads/custom-fields.service';
import { AttributionService } from '../attribution/attribution.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { LeadInsightsService } from '../lead-insights/lead-insights.service';
import { IMPORT_FIELDS, IMPORT_GROUP_NAME } from './sheet-import.fields';
import { mapRow, parseCsv, type ImportedLead } from './sheet-import.parser';

export interface RunContext {
  tenantId: string;
  pipelineId: string;
  stageId: string;
  instancia: string;
}

export interface RunSummary {
  total: number;
  novas: number;
  anexadas: number;
  puladas: number;
  erros: number;
  semMudanca: boolean;
}

/** Grupo "Formulário Meta" fica depois do "Principal" (ordem 0). */
const GRUPO_ORDEM = 10;
const MAX_TENTATIVAS = 3;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Importa leads da planilha pública do Meta Lead Ads para UM tenant,
 * configurado por env. Ver spec 2026-09-08-importacao-planilha-meta-design.md.
 */
@Injectable()
export class SheetImportService implements OnModuleInit {
  private readonly logger = new Logger(SheetImportService.name);
  private readonly tenantId: string;
  private readonly sheetId: string;
  private readonly gid: string;
  private readonly pipelineIdEnv: string;
  private readonly stageIdEnv: string;
  private running = false;
  /** Hash do último CSV processado sem erro; igual = planilha não mudou. */
  private lastHash: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly customFields: CustomFieldsService,
    private readonly attribution: AttributionService,
    private readonly gateway: CrmGateway,
    private readonly insights: LeadInsightsService,
  ) {
    this.tenantId = this.config.get<string>('SHEET_IMPORT_TENANT_ID', '');
    this.sheetId = this.config.get<string>('SHEET_IMPORT_SHEET_ID', '');
    this.gid = this.config.get<string>('SHEET_IMPORT_GID', '');
    this.pipelineIdEnv = this.config.get<string>('SHEET_IMPORT_PIPELINE_ID', '');
    this.stageIdEnv = this.config.get<string>('SHEET_IMPORT_STAGE_ID', '');
  }

  isEnabled(): boolean {
    return this.tenantId !== '' && this.sheetId !== '';
  }

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log('Importação de planilha desligada (SHEET_IMPORT_* ausente)');
      return;
    }
    // Primeira rodada logo após o boot: backfill e recuperação após restart.
    void this.tick();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.isEnabled() || this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch (err) {
      this.logger.warn(`Importação da planilha falhou: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async resolveContext(): Promise<RunContext> {
    let pipelineId = this.pipelineIdEnv;
    if (pipelineId === '') {
      const pipeline = await this.prisma.pipeline.findFirst({
        where: { tenant_id: this.tenantId },
        orderBy: { ordem: 'asc' },
        select: { id: true },
      });
      if (!pipeline) throw new Error(`tenant ${this.tenantId} sem pipeline`);
      pipelineId = pipeline.id;
    }

    let stageId = this.stageIdEnv;
    if (stageId === '') {
      // Etapa BASE (user_id null): com kanban individual ligado, as cópias
      // pessoais têm o mesmo nome; lead sem dono pertence ao conjunto base.
      const stage = await this.prisma.stage.findFirst({
        where: { pipeline_id: pipelineId, tenant_id: this.tenantId, user_id: null },
        orderBy: { ordem: 'asc' },
        select: { id: true },
      });
      if (!stage) throw new Error(`pipeline ${pipelineId} sem etapa base`);
      stageId = stage.id;
    }

    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { tenant_id: this.tenantId },
      orderBy: [{ ultimo_check: 'desc' }, { created_at: 'asc' }],
      select: { nome: true },
    });

    return { tenantId: this.tenantId, pipelineId, stageId, instancia: inst?.nome ?? '' };
  }

  /** Garante grupo "Formulário Meta" e as definições de IMPORT_FIELDS. Idempotente. */
  async ensureFieldDefs(tenantId: string): Promise<void> {
    await this.customFields.ensureTenantBootstrap(tenantId);

    const grupo =
      (await this.prisma.customFieldGroup.findFirst({
        where: { tenant_id: tenantId, escopo: 'LEAD', nome: IMPORT_GROUP_NAME },
        select: { id: true },
      })) ??
      (await this.prisma.customFieldGroup.create({
        data: { tenant_id: tenantId, escopo: 'LEAD', nome: IMPORT_GROUP_NAME, ordem: GRUPO_ORDEM },
        select: { id: true },
      }));

    const existentes = await this.prisma.customFieldDef.findMany({
      where: { tenant_id: tenantId, escopo: 'LEAD', key: { in: IMPORT_FIELDS.map((f) => f.key) } },
      select: { key: true },
    });
    const ocupadas = new Set(existentes.map((d) => d.key));
    const faltam = IMPORT_FIELDS.filter((f) => !ocupadas.has(f.key));
    if (faltam.length === 0) return;

    await this.prisma.customFieldDef.createMany({
      data: faltam.map((f) => ({
        tenant_id: tenantId,
        escopo: 'LEAD' as const,
        key: f.key,
        nome: f.nome,
        tipo: f.tipo,
        options: f.options ?? undefined,
        ordem: f.ordem,
        group_id: grupo.id,
        active: true,
        visible: true,
        api_only: false,
      })),
      skipDuplicates: true,
    });
    this.logger.log(`Campos do formulário Meta criados no tenant ${tenantId}: ${faltam.map((f) => f.key).join(', ')}`);
  }

  // run() e processRow() entram nas Tasks 6 e 7.
  async run(): Promise<RunSummary> {
    throw new Error('não implementado');
  }
}
```

Nota: `Prisma`, `createHash`, `mapRow`, `parseCsv`, `ImportedLead`, `MAX_TENTATIVAS`, `FETCH_TIMEOUT_MS` ficam importados/declarados agora e são usados nas Tasks 6–7. Se o lint reclamar de não-uso neste commit, prefixar com `void` temporário NÃO — basta deixar: o ESLint do projeto marca `no-unused-vars` como erro? Verificar com `npm run lint`; se marcar, mover esses imports para a Task 6.

```ts
// apps/api/src/modules/sheet-import/sheet-import.module.ts
import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { AttributionModule } from '../attribution/attribution.module';
import { SheetImportService } from './sheet-import.service';

/**
 * Importação da planilha Meta Lead Ads (um tenant, por env). PrismaService,
 * CrmGateway e LeadInsightsService vêm de módulos @Global; ConfigModule é
 * global no AppModule.
 */
@Module({
  imports: [LeadsModule, AttributionModule],
  providers: [SheetImportService],
})
export class SheetImportModule {}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.service.spec.ts && npm run typecheck`
Expected: PASS nos 6 testes; typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sheet-import/
git commit -m "feat(api): SheetImportService — config por env, contexto do tenant e campos do formulario Meta"
```

---

### Task 6: `SheetImportService.processRow` — criar ou anexar lead

**Files:**
- Modify: `apps/api/src/modules/sheet-import/sheet-import.service.ts`
- Test: `apps/api/src/modules/sheet-import/sheet-import.service.spec.ts`

**Interfaces:**
- Consumes: `ImportedLead` (Task 2), `RunContext` (Task 5), `LeadInsightsService.enfileirarImportado(leadId, tenantId)` (Task 9 — no service spec é mock; no typecheck só compila depois da Task 9, por isso a Task 9 pode ser executada antes desta se o executor preferir; a ordem aqui está pela lógica de leitura).
- Produces: `processRow(lead: ImportedLead, ctx: RunContext): Promise<'created' | 'attached'>`.

**Ordem de execução recomendada:** Task 9 (método `enfileirarImportado`) ANTES desta, para o typecheck passar. Se rodar nesta ordem, adicionar temporariamente em `LeadInsightsService` apenas a assinatura:

```ts
  /** Implementação real na Task 9. */
  async enfileirarImportado(leadId: string, tenantId: string): Promise<void> {
    await this.enfileirar(leadId, tenantId, `lead-${leadId}`, ATRASO_GATILHO_MS);
  }
```

- [ ] **Step 1: Testes que falham**

Acrescentar ao spec:

```ts
import type { ImportedLead } from './sheet-import.parser';

const CTX = { tenantId: 't1', pipelineId: 'p1', stageId: 's1', instancia: 'leads' };

function leadImportado(overrides: Partial<ImportedLead> = {}): ImportedLead {
  return {
    sourceRowId: 'l:100',
    nome: 'Eduardo',
    telefone: '5519997094696',
    email: 'e@x.com',
    companyType: 'MEI',
    dadosCustom: { tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei', cidade: 'Paulínia' },
    tags: ['MEI'],
    attribution: { utm_source: 'ig', utm_medium: 'paid', campaignid: '1' },
    atividadeTexto: 'Tipo de empresa: MEI (Mei) · Paulínia',
    ...overrides,
  };
}

describe('SheetImportService.processRow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T15:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('telefone novo: cria lead sem dono na etapa configurada, atividade, tags, registro, WS, atribuição e ficha', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockResolvedValue({ id: 'lead-novo' });
    m.prisma.tag.upsert.mockResolvedValue({ id: 'tag-mei', nome: 'MEI' });

    const r = await m.service.processRow(leadImportado(), CTX);

    expect(r).toBe('created');
    expect(m.customFields.validateValues).toHaveBeenCalledWith(
      { tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei', cidade: 'Paulínia' },
      't1',
      'LEAD',
    );
    const [{ data }] = m.prisma.lead.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({
      nome: 'Eduardo',
      telefone: '5519997094696',
      email: 'e@x.com',
      origem: 'IMPORT',
      temperatura: 'FRIO',
      responsavel_id: null,
      lead_scope: 't1',
      tenant_id: 't1',
      pipeline_id: 'p1',
      estagio_id: 's1',
      instancia_whatsapp: 'leads',
      tags: ['MEI'],
      dados_custom: { tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei', cidade: 'Paulínia' },
    });
    expect(data.position).toBe(-Date.now());
    expect(data.estagio_entered_at).toEqual(new Date());

    expect(m.prisma.leadActivity.create).toHaveBeenCalledWith({
      data: {
        lead_id: 'lead-novo',
        tenant_id: 't1',
        tipo: 'lead_created',
        descricao: 'Importado da planilha de leads (Meta Lead Ads). Tipo de empresa: MEI (Mei) · Paulínia',
      },
    });
    expect(m.prisma.tag.upsert).toHaveBeenCalledWith({
      where: { tenant_id_nome: { tenant_id: 't1', nome: 'MEI' } },
      update: {},
      create: { nome: 'MEI', tenant_id: 't1' },
      select: { id: true, nome: true },
    });
    expect(m.prisma.leadTag.createMany).toHaveBeenCalledWith({
      data: [{ lead_id: 'lead-novo', tag_id: 'tag-mei', tenant_id: 't1' }],
      skipDuplicates: true,
    });
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith({
      where: { tenant_id_source_row_id: { tenant_id: 't1', source_row_id: 'l:100' } },
      create: { tenant_id: 't1', source_row_id: 'l:100', lead_id: 'lead-novo', status: 'ok', detail: null },
      update: { lead_id: 'lead-novo', status: 'ok', detail: null },
    });
    expect(m.gateway.emitLeadCreated).toHaveBeenCalledWith('lead-novo', { pipeline_id: 'p1', estagio_id: 's1' }, 't1');
    expect(m.attribution.recordFirstTouch).toHaveBeenCalledWith('lead-novo', 't1', {
      utm_source: 'ig',
      utm_medium: 'paid',
      campaignid: '1',
    });
    expect(m.insights.enfileirarImportado).toHaveBeenCalledWith('lead-novo', 't1');
  });

  it('telefone já existe: anexa campos vazios, e-mail e tags; não cria, não muda etapa/dono, não enfileira ficha', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue({
      id: 'lead-velho',
      email: null,
      tags: ['VIP'],
      dados_custom: { cidade: 'Campinas' },
    });
    m.prisma.tag.upsert.mockResolvedValue({ id: 'tag-mei', nome: 'MEI' });

    const r = await m.service.processRow(leadImportado(), CTX);

    expect(r).toBe('attached');
    expect(m.prisma.lead.create).not.toHaveBeenCalled();
    const [{ where, data }] = m.prisma.lead.update.mock.calls[0] as [
      { where: { id: string }; data: Record<string, unknown> },
    ];
    expect(where).toEqual({ id: 'lead-velho' });
    // cidade existente é preservada; chaves novas entram.
    expect(data.dados_custom).toEqual({ cidade: 'Campinas', tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei' });
    expect(data.email).toBe('e@x.com');
    expect(data.tags).toEqual(['VIP', 'MEI']);
    expect(data).not.toHaveProperty('estagio_id');
    expect(data).not.toHaveProperty('responsavel_id');
    expect(m.prisma.leadActivity.create).toHaveBeenCalledWith({
      data: {
        lead_id: 'lead-velho',
        tenant_id: 't1',
        tipo: 'lead_updated',
        descricao: 'Dados do formulário Meta anexados. Tipo de empresa: MEI (Mei) · Paulínia',
      },
    });
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { tenant_id: 't1', source_row_id: 'l:100', lead_id: 'lead-velho', status: 'ok', detail: null },
      }),
    );
    expect(m.gateway.emitLeadCreated).not.toHaveBeenCalled();
    expect(m.attribution.recordFirstTouch).not.toHaveBeenCalled();
    expect(m.insights.enfileirarImportado).not.toHaveBeenCalled();
  });

  it('lead existente com e-mail mantém o e-mail dele', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue({ id: 'l', email: 'dono@x.com', tags: [], dados_custom: {} });
    await m.service.processRow(leadImportado({ tags: [] }), CTX);
    const [{ data }] = m.prisma.lead.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).not.toHaveProperty('email');
  });

  it('sem tags não chama tag.upsert nem leadTag.createMany', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockResolvedValue({ id: 'n' });
    await m.service.processRow(leadImportado({ tags: [], companyType: 'ME_LTDA' }), CTX);
    expect(m.prisma.tag.upsert).not.toHaveBeenCalled();
    expect(m.prisma.leadTag.createMany).not.toHaveBeenCalled();
  });

  it('falha na atribuição ou no WS não derruba o processamento (lead já gravado)', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockResolvedValue({ id: 'n' });
    m.gateway.emitLeadCreated.mockImplementation(() => {
      throw new Error('socket caiu');
    });
    m.insights.enfileirarImportado.mockRejectedValue(new Error('redis caiu'));
    await expect(m.service.processRow(leadImportado({ tags: [] }), CTX)).resolves.toBe('created');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.service.spec.ts -t processRow`
Expected: FAIL — `processRow is not a function`.

- [ ] **Step 3: Implementar `processRow`**

Substituir o stub `run()` por este bloco (o `run()` real vem na Task 7; manter o stub `run()` por enquanto abaixo de `processRow`):

```ts
  /**
   * Cria o lead da linha ou anexa os dados a um lead existente com o mesmo
   * telefone no pipeline. Lead + atividade + registro da linha saem numa
   * transação curta; WS, atribuição e ficha ficam fora e nunca lançam.
   */
  async processRow(lead: ImportedLead, ctx: RunContext): Promise<'created' | 'attached'> {
    const dadosCustom = (await this.customFields.validateValues(
      lead.dadosCustom,
      ctx.tenantId,
      'LEAD',
    )) as Prisma.InputJsonObject;

    const existente = await this.prisma.lead.findUnique({
      where: {
        telefone_pipeline_scope: {
          telefone: lead.telefone,
          pipeline_id: ctx.pipelineId,
          lead_scope: ctx.tenantId,
        },
      },
      select: { id: true, email: true, tags: true, dados_custom: true },
    });

    const tagIds = await this.upsertTags(ctx.tenantId, lead.tags);

    if (existente) {
      const atuais = (existente.dados_custom ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...atuais };
      for (const [k, v] of Object.entries(dadosCustom)) {
        const atual = atuais[k];
        if (atual === undefined || atual === null || atual === '') merged[k] = v;
      }
      const tagsAtuais = Array.isArray(existente.tags) ? (existente.tags as string[]) : [];
      const tagsMerged = [...new Set([...tagsAtuais, ...lead.tags])];

      const data: Prisma.LeadUpdateInput = {
        dados_custom: merged as Prisma.InputJsonObject,
        tags: tagsMerged,
      };
      if (!existente.email && lead.email) data.email = lead.email;

      await this.prisma.$transaction(async (tx) => {
        await tx.lead.update({ where: { id: existente.id }, data });
        await tx.leadActivity.create({
          data: {
            lead_id: existente.id,
            tenant_id: ctx.tenantId,
            tipo: 'lead_updated',
            descricao: `Dados do formulário Meta anexados. ${lead.atividadeTexto}`,
          },
        });
        await this.vincularTags(tx, existente.id, ctx.tenantId, tagIds);
        await this.registrarLinha(tx, ctx.tenantId, lead.sourceRowId, existente.id);
      });
      return 'attached';
    }

    const agora = new Date();
    const novo = await this.prisma.$transaction(async (tx) => {
      const criado = await tx.lead.create({
        data: {
          nome: lead.nome,
          telefone: lead.telefone,
          email: lead.email,
          origem: 'IMPORT',
          temperatura: 'FRIO',
          responsavel_id: null,
          lead_scope: ctx.tenantId,
          tenant_id: ctx.tenantId,
          pipeline_id: ctx.pipelineId,
          estagio_id: ctx.stageId,
          estagio_entered_at: agora,
          position: -agora.getTime(),
          instancia_whatsapp: ctx.instancia,
          tags: lead.tags,
          dados_custom: dadosCustom,
        },
        select: { id: true },
      });
      await tx.leadActivity.create({
        data: {
          lead_id: criado.id,
          tenant_id: ctx.tenantId,
          tipo: 'lead_created',
          descricao: `Importado da planilha de leads (Meta Lead Ads). ${lead.atividadeTexto}`,
        },
      });
      await this.vincularTags(tx, criado.id, ctx.tenantId, tagIds);
      await this.registrarLinha(tx, ctx.tenantId, lead.sourceRowId, criado.id);
      return criado;
    });

    // Fora da transação e à prova de falha: o lead já existe.
    try {
      this.gateway.emitLeadCreated(novo.id, { pipeline_id: ctx.pipelineId, estagio_id: ctx.stageId }, ctx.tenantId);
    } catch (err) {
      this.logger.warn(`WS lead:created falhou para ${novo.id}: ${(err as Error).message}`);
    }
    await this.attribution.recordFirstTouch(novo.id, ctx.tenantId, lead.attribution);
    try {
      await this.insights.enfileirarImportado(novo.id, ctx.tenantId);
    } catch (err) {
      this.logger.warn(`Ficha IA não enfileirada para ${novo.id}: ${(err as Error).message}`);
    }
    return 'created';
  }

  private async upsertTags(tenantId: string, nomes: string[]): Promise<string[]> {
    const unicos = [...new Set(nomes.map((n) => n.trim()).filter((n) => n !== ''))];
    if (unicos.length === 0) return [];
    const tags = await Promise.all(
      unicos.map((nome) =>
        this.prisma.tag.upsert({
          where: { tenant_id_nome: { tenant_id: tenantId, nome } },
          update: {},
          create: { nome, tenant_id: tenantId },
          select: { id: true, nome: true },
        }),
      ),
    );
    return tags.map((t) => t.id);
  }

  private async vincularTags(
    tx: Prisma.TransactionClient,
    leadId: string,
    tenantId: string,
    tagIds: string[],
  ): Promise<void> {
    if (tagIds.length === 0) return;
    await tx.leadTag.createMany({
      data: tagIds.map((tag_id) => ({ lead_id: leadId, tag_id, tenant_id: tenantId })),
      skipDuplicates: true,
    });
  }

  private async registrarLinha(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sourceRowId: string,
    leadId: string,
  ): Promise<void> {
    await tx.sheetImportRow.upsert({
      where: { tenant_id_source_row_id: { tenant_id: tenantId, source_row_id: sourceRowId } },
      create: { tenant_id: tenantId, source_row_id: sourceRowId, lead_id: leadId, status: 'ok', detail: null },
      update: { lead_id: leadId, status: 'ok', detail: null },
    });
  }
```

`recordFirstTouch` já engole os próprios erros (nunca lança), por isso não tem try/catch.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.service.spec.ts && npm run typecheck`
Expected: PASS. Se `tags: lead.tags` reclamar de tipo Json, usar `tags: lead.tags as Prisma.InputJsonValue`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sheet-import/ apps/api/src/modules/lead-insights/lead-insights.service.ts
git commit -m "feat(api): processRow — cria lead importado ou anexa formulario a lead existente"
```

---

### Task 7: `SheetImportService.run` — fetch, hash, registro e resumo; wiring no AppModule

**Files:**
- Modify: `apps/api/src/modules/sheet-import/sheet-import.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/modules/sheet-import/sheet-import.service.spec.ts`

**Interfaces:**
- Consumes: `parseCsv`, `mapRow` (Tasks 1–2), `processRow`, `resolveContext`, `ensureFieldDefs` (Tasks 5–6).
- Produces: `run(): Promise<RunSummary>`; `sheetUrl(): string`.

- [ ] **Step 1: Testes que falham**

Acrescentar ao spec:

```ts
const CSV_HEADER =
  'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,form_name,is_organic,platform,há_quantos_anos_na_atua_com_vendas_de_consórcio?,possui_estrutura_física?,tem_quantos_vendedores?,média_de_produção_mensal?,sua_empresa_é_mei_ou_ltda?,Email,Nome Completo,Telefone,Cidade,estado,lead_status';
const LINHA_A = 'l:1,2026-09-04T11:17:13-05:00,ag:1,02,as:1,Conj,c:1,Camp,f:1,Form,false,ig,3 anos,Não,1,500 mil,Mei,a@x.com,Ana,p:+5519997094696,Paulínia,SP,CREATED';
const LINHA_B = 'l:2,2026-09-04T12:00:00-05:00,ag:1,02,as:1,Conj,c:1,Camp,f:1,Form,false,ig,1,Sim,2,100 mil,Ltda,b@x.com,Bia,p:11945550754,São Paulo,SP,CREATED';
const LINHA_TESTE =
  'l:9,2026-06-22T15:34:49-05:00,,,,,,,f:1,Form,true,,<test lead: dummy data for x>,<test lead: dummy data for y>,x,y,z,test@meta.com,<test lead: dummy data for Nome Completo>,p:<test lead: dummy data for Telefone>,c,e,ok';

function respostaCsv(texto: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => texto };
}

describe('SheetImportService.run', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function prepararFeliz(csv: string) {
    const m = montar(ENV_OK);
    fetchMock.mockResolvedValue(respostaCsv(csv));
    m.prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1' });
    m.prisma.stage.findFirst.mockResolvedValue({ id: 's1' });
    m.prisma.whatsappInstance.findFirst.mockResolvedValue({ nome: 'leads' });
    m.prisma.customFieldGroup.findFirst.mockResolvedValue({ id: 'g1' });
    m.prisma.customFieldDef.findMany.mockResolvedValue(IMPORT_FIELDS.map((f) => ({ key: f.key })));
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockImplementation(async ({ data }: { data: { telefone: string } }) => ({ id: `lead-${data.telefone}` }));
    m.prisma.tag.upsert.mockResolvedValue({ id: 'tag', nome: 'MEI' });
    return m;
  }

  it('monta a URL de export com gid opcional', () => {
    expect(montar(ENV_OK).service.sheetUrl()).toBe(
      'https://docs.google.com/spreadsheets/d/sheet-abc/export?format=csv',
    );
    expect(montar({ ...ENV_OK, SHEET_IMPORT_GID: '77' }).service.sheetUrl()).toBe(
      'https://docs.google.com/spreadsheets/d/sheet-abc/export?format=csv&gid=77',
    );
  });

  it('primeira rodada: cria as linhas reais, registra a de teste como skipped e resume', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A, LINHA_B, LINHA_TESTE].join('\n'));

    const r = await m.service.run();

    expect(r).toEqual({ total: 3, novas: 2, anexadas: 0, puladas: 1, erros: 0, semMudanca: false });
    expect(m.prisma.lead.create).toHaveBeenCalledTimes(2);
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith({
      where: { tenant_id_source_row_id: { tenant_id: 't1', source_row_id: 'l:9' } },
      create: { tenant_id: 't1', source_row_id: 'l:9', lead_id: null, status: 'skipped', detail: 'linha de teste do Meta' },
      update: { status: 'skipped', detail: 'linha de teste do Meta' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://docs.google.com/spreadsheets/d/sheet-abc/export?format=csv',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('linhas já registradas (ok/skipped) não são reprocessadas; error com attempts < 3 é retentada', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A, LINHA_B, LINHA_TESTE].join('\n'));
    m.prisma.sheetImportRow.findMany.mockResolvedValue([
      { source_row_id: 'l:1', status: 'ok', attempts: 1 },
      { source_row_id: 'l:9', status: 'skipped', attempts: 1 },
      { source_row_id: 'l:2', status: 'error', attempts: 2 },
    ]);

    const r = await m.service.run();

    expect(r.novas).toBe(1);
    expect(m.prisma.lead.create).toHaveBeenCalledTimes(1);
    const [{ data }] = m.prisma.lead.create.mock.calls[0] as [{ data: { telefone: string } }];
    expect(data.telefone).toBe('5511945550754');
  });

  it('error com attempts >= 3 não é retentada', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_B].join('\n'));
    m.prisma.sheetImportRow.findMany.mockResolvedValue([{ source_row_id: 'l:2', status: 'error', attempts: 3 }]);
    const r = await m.service.run();
    expect(r).toEqual({ total: 1, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: false });
    expect(m.prisma.lead.create).not.toHaveBeenCalled();
  });

  it('erro numa linha grava status error com attempts incrementado e segue as outras', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A, LINHA_B].join('\n'));
    m.prisma.$transaction
      .mockImplementationOnce(async () => {
        throw new Error('deadlock');
      })
      .mockImplementation(async (fn: (tx: typeof m.prisma) => Promise<unknown>) => fn(m.prisma));

    const r = await m.service.run();

    expect(r.novas).toBe(1);
    expect(r.erros).toBe(1);
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith({
      where: { tenant_id_source_row_id: { tenant_id: 't1', source_row_id: 'l:1' } },
      create: { tenant_id: 't1', source_row_id: 'l:1', lead_id: null, status: 'error', detail: 'deadlock', attempts: 1 },
      update: { status: 'error', detail: 'deadlock', attempts: { increment: 1 } },
    });
  });

  it('hash igual ao da rodada anterior sem erros encerra sem consultar o banco', async () => {
    const csv = [CSV_HEADER, LINHA_A].join('\n');
    const m = prepararFeliz(csv);
    await m.service.run();
    m.prisma.sheetImportRow.findMany.mockClear();

    const r = await m.service.run();

    expect(r).toEqual({ total: 1, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: true });
    expect(m.prisma.sheetImportRow.findMany).not.toHaveBeenCalled();
  });

  it('rodada com erro NÃO grava o hash: a próxima reprocessa', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A].join('\n'));
    m.prisma.$transaction.mockImplementationOnce(async () => {
      throw new Error('x');
    });
    await m.service.run();
    const r = await m.service.run();
    expect(r.semMudanca).toBe(false);
  });

  it('HTTP não-2xx lança e nada é registrado', async () => {
    const m = montar(ENV_OK);
    fetchMock.mockResolvedValue(respostaCsv('', 403));
    await expect(m.service.run()).rejects.toThrow('HTTP 403');
    expect(m.prisma.sheetImportRow.upsert).not.toHaveBeenCalled();
  });

  it('HTML de login (planilha privada) é tratado como falha de download', async () => {
    const m = montar(ENV_OK);
    fetchMock.mockResolvedValue(respostaCsv('<!DOCTYPE html><html><head><title>Google Accounts</title>'));
    await expect(m.service.run()).rejects.toThrow('planilha não está acessível por link público');
  });

  it('CSV sem linhas de dados resume zero sem erro', async () => {
    const m = prepararFeliz(CSV_HEADER);
    await expect(m.service.run()).resolves.toEqual({ total: 0, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: false });
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd apps/api && npx jest src/modules/sheet-import/sheet-import.service.spec.ts -t run`
Expected: FAIL — `sheetUrl is not a function` e `run` lança "não implementado".

- [ ] **Step 3: Implementar `run` e `sheetUrl`**

Substituir o stub `run()`:

```ts
  sheetUrl(): string {
    const base = `https://docs.google.com/spreadsheets/d/${this.sheetId}/export?format=csv`;
    return this.gid !== '' ? `${base}&gid=${encodeURIComponent(this.gid)}` : base;
  }

  private async baixarCsv(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(this.sheetUrl(), { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar a planilha`);
      const texto = await res.text();
      // Planilha privada devolve a página de login do Google com status 200.
      const cabecalho = texto.slice(0, 2000);
      if (!cabecalho.includes('id') || !cabecalho.includes('Telefone') || cabecalho.trimStart().startsWith('<')) {
        throw new Error('planilha não está acessível por link público (resposta não é CSV com colunas id/Telefone)');
      }
      return texto;
    } finally {
      clearTimeout(timer);
    }
  }

  async run(): Promise<RunSummary> {
    const csv = await this.baixarCsv();
    const hash = createHash('sha256').update(csv).digest('hex');
    const rows = parseCsv(csv);
    const resumo: RunSummary = { total: rows.length, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: false };

    if (hash === this.lastHash) {
      resumo.semMudanca = true;
      this.logger.debug('Planilha sem mudanças desde a última rodada');
      return resumo;
    }

    const vistas = await this.prisma.sheetImportRow.findMany({
      where: { tenant_id: this.tenantId },
      select: { source_row_id: true, status: true, attempts: true },
    });
    const registro = new Map(vistas.map((v) => [v.source_row_id, v]));

    const pendentes = rows.filter((row) => {
      const id = (row.id ?? '').trim();
      const visto = registro.get(id);
      if (!visto) return true;
      return visto.status === 'error' && visto.attempts < MAX_TENTATIVAS;
    });

    if (pendentes.length > 0) {
      await this.ensureFieldDefs(this.tenantId);
      const ctx = await this.resolveContext();

      for (const row of pendentes) {
        const mapped = mapRow(row);
        if (!mapped.ok) {
          const id = (row.id ?? '').trim() || `sem-id:${resumo.puladas}`;
          await this.marcarLinha(id, 'skipped', mapped.motivo);
          resumo.puladas++;
          continue;
        }
        try {
          const r = await this.processRow(mapped.lead, ctx);
          if (r === 'created') resumo.novas++;
          else resumo.anexadas++;
        } catch (err) {
          resumo.erros++;
          const msg = (err as Error).message ?? String(err);
          this.logger.warn(`Linha ${mapped.lead.sourceRowId} falhou: ${msg}`);
          await this.marcarLinha(mapped.lead.sourceRowId, 'error', msg);
        }
      }
    }

    if (resumo.erros === 0) this.lastHash = hash;
    this.logger.log(
      `Importação da planilha: ${resumo.total} linhas, ${resumo.novas} novas, ${resumo.anexadas} anexadas, ${resumo.puladas} puladas, ${resumo.erros} erros`,
    );
    return resumo;
  }

  private async marcarLinha(sourceRowId: string, status: 'skipped' | 'error', detail: string): Promise<void> {
    const where = { tenant_id_source_row_id: { tenant_id: this.tenantId, source_row_id: sourceRowId } };
    if (status === 'skipped') {
      await this.prisma.sheetImportRow.upsert({
        where,
        create: { tenant_id: this.tenantId, source_row_id: sourceRowId, lead_id: null, status, detail },
        update: { status, detail },
      });
      return;
    }
    await this.prisma.sheetImportRow.upsert({
      where,
      create: { tenant_id: this.tenantId, source_row_id: sourceRowId, lead_id: null, status, detail, attempts: 1 },
      update: { status, detail, attempts: { increment: 1 } },
    });
  }
```

Registrar o módulo em `apps/api/src/app.module.ts`: importar `SheetImportModule` de `./modules/sheet-import/sheet-import.module` e adicionar ao array `imports` logo após `LeadInsightsModule`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd apps/api && npx jest src/modules/sheet-import && npm run typecheck && npm run lint -- --quiet`
Expected: PASS em parser e service; typecheck e lint limpos.

- [ ] **Step 5: Boot local sem env (módulo inerte)**

Run: `cd apps/api && timeout 40 npm run start:dev 2>&1 | grep -m1 -E "Importação de planilha desligada|SheetImportService"` (ou o comando de start que o projeto usa; conferir `package.json`).
Expected: linha `Importação de planilha desligada (SHEET_IMPORT_* ausente)`. Se o boot local não for viável (Redis ausente), pular e anotar no commit.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/sheet-import/ apps/api/src/app.module.ts
git commit -m "feat(api): SheetImportService.run — download, hash, registro de linhas, cron 5min e boot"
```

---

### Task 8: Prompt da Ficha IA — bloco "Cadastro e formulário" e modo pré-contato

**Files:**
- Modify: `apps/api/src/modules/lead-insights/insight-prompt.ts:10-26` (interface) e `:433-490` (`montarPromptInsight`)
- Test: `apps/api/src/modules/lead-insights/insight-prompt.spec.ts`

**Interfaces:**
- Produces:
  - `InsightContexto.lead.origem: string` e `InsightContexto.lead.cadastro: Array<{ rotulo: string; valor: string }>` (ambos obrigatórios na interface; chamador preenche `[]`/`''`).
  - `montarPromptInsight` gera bloco `## Cadastro e formulário` quando `cadastro.length > 0`; quando `mensagens.length === 0`, instrução de pré-contato.

- [ ] **Step 1: Testes que falham**

Acrescentar ao `insight-prompt.spec.ts`:

```ts
import { montarPromptInsight, type InsightContexto } from './insight-prompt';

function contexto(overrides: Partial<InsightContexto['lead']> = {}, mensagens: InsightContexto['mensagens'] = []): InsightContexto {
  return {
    lead: {
      nome: 'Eduardo',
      telefone: '5519997094696',
      etapa: 'Novo',
      temperatura: 'FRIO',
      valor_estimado: null,
      ultima_interacao: null,
      etapas_disponiveis: ['Em contato', 'Qualificado'],
      origem: 'IMPORT',
      cadastro: [],
      ...overrides,
    },
    insightAnterior: null,
    mensagens,
  };
}

const MSG = { de: 'cliente' as const, texto: 'oi', em: new Date('2026-09-08T12:00:00Z') };

describe('montarPromptInsight — cadastro e pré-contato', () => {
  it('sem cadastro e com conversa: prompt igual ao de antes (sem bloco de cadastro, sem pré-contato)', () => {
    const [, user] = montarPromptInsight(contexto({}, [MSG]));
    expect(user.content).not.toContain('## Cadastro e formulário');
    expect(user.content).not.toContain('AINDA NAO HOUVE CONVERSA');
    expect(user.content).toContain('Analise a conversa acima');
  });

  it('cadastro entra como bloco com uma linha por item, achatado', () => {
    const [, user] = montarPromptInsight(
      contexto({ cadastro: [{ rotulo: 'Tipo de empresa', valor: 'MEI' }, { rotulo: 'Cidade', valor: 'Paulínia\nSP' }] }, [MSG]),
    );
    expect(user.content).toContain('## Cadastro e formulário\n- Tipo de empresa: MEI\n- Cidade: Paulínia SP');
  });

  it('sem mensagens e com cadastro: modo pré-contato substitui a instrução final', () => {
    const [, user] = montarPromptInsight(contexto({ cadastro: [{ rotulo: 'Tipo de empresa', valor: 'MEI' }] }));
    expect(user.content).toContain('AINDA NAO HOUVE CONVERSA');
    expect(user.content).toContain('Origem do lead: IMPORT');
    expect(user.content).toContain('"nota_atendimento": null');
    expect(user.content).toContain('"proxima_acao_em_dias": 1');
    expect(user.content).not.toContain('Analise a conversa acima');
  });

  it('origem em texto legível quando é IMPORT', () => {
    const [, user] = montarPromptInsight(contexto({ cadastro: [{ rotulo: 'x', valor: 'y' }] }));
    expect(user.content).toContain('planilha de leads do Meta Lead Ads');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd apps/api && npx jest src/modules/lead-insights/insight-prompt.spec.ts -t "cadastro"`
Expected: FAIL — TypeScript reclama de `origem`/`cadastro` na interface, ou asserts falham.

- [ ] **Step 3: Implementar**

Na interface `InsightContexto.lead` (após `etapas_disponiveis`):

```ts
    /** `Lead.origem` cru (WHATSAPP_INCOMING, IMPORT, MANUAL...). */
    origem: string;
    /**
     * Dados de cadastro e formulário (campos custom com rótulo do tenant,
     * e-mail, campanha). Lista vazia = nada além do que já está em `nome`/`telefone`.
     * É o que permite ficha ANTES da primeira mensagem (lead importado).
     */
    cadastro: Array<{ rotulo: string; valor: string }>;
```

Em `montarPromptInsight`, após `blocoAnterior` e antes de `blocoMensagens`:

```ts
  const LIMITE_CADASTRO = 200;
  const blocoCadastro =
    lead.cadastro.length > 0
      ? [
          '## Cadastro e formulário',
          ...lead.cadastro.map(
            (c) => `- ${comoTexto(c.rotulo, 60)}: ${comoTexto(c.valor.replace(/\s*\n+\s*/g, ' '), LIMITE_CADASTRO)}`,
          ),
        ].join('\n')
      : '';

  const preContato = mensagens.length === 0 && lead.cadastro.length > 0;
  const origemLegivel = lead.origem === 'IMPORT' ? 'planilha de leads do Meta Lead Ads (tráfego pago)' : lead.origem;

  const instrucaoFinal = preContato
    ? [
        `AINDA NAO HOUVE CONVERSA com este lead. Origem do lead: ${lead.origem} (${origemLegivel}).`,
        'Monte a ficha SOMENTE a partir do cadastro e formulário acima:',
        '- "resumo": perfil do lead (quem é, tempo de atuação, estrutura, produção) e ADERÊNCIA ao perfil que a empresa atende — a empresa só cadastra parceiros ME/LTDA para cima; MEI e pessoa física estão fora do perfil e isso deve ser dito com clareza no resumo.',
        '- "memoria_novos_fatos": fatos objetivos do formulário (tipo de empresa, cidade, produção, vendedores), com "quando_dito" = data do formulário se houver.',
        '- "msg_sugerida": abertura da LIGAÇÃO ou primeira mensagem de WhatsApp para este lead, citando algo do formulário.',
        '- "proxima_acao_em_dias": 1 e "proxima_acao_motivo": por que ligar já.',
        '- "nota_atendimento": null, "nota_ponto_forte": "", "nota_ponto_melhoria": "" (não há atendimento para avaliar).',
        '- "temperatura_sugerida", "etapa_sugerida", "ultima_compra": null. "lembretes": [].',
        'Responda apenas com o objeto JSON das 14 chaves.',
      ].join('\n')
    : 'Analise a conversa acima e responda apenas com o objeto JSON das 14 chaves.';
```

E montar `user` assim (substituindo o array atual):

```ts
  const user = [
    '## Dados do lead',
    linhasLead,
    '',
    blocoEtapas,
    '',
    blocoAnterior,
    ...(blocoCadastro !== '' ? ['', blocoCadastro] : []),
    '',
    '## Conversa (mais antiga primeiro)',
    blocoMensagens,
    '',
    instrucaoFinal,
  ].join('\n');
```

Nota: `comoTexto` já existe no arquivo (linha ~164). O teste "Cidade: Paulínia SP" depende do `replace` de quebra de linha por espaço.

- [ ] **Step 4: Corrigir chamadores/fixtures que constroem `InsightContexto`**

Run: `cd apps/api && npm run typecheck`
Expected: erros em `lead-insights.service.ts` (contexto sem `origem`/`cadastro`) e possivelmente em specs. No service, adicionar temporariamente `origem: '', cadastro: []` no objeto `contexto` (Task 9 substitui pelo real). Em specs que constroem `InsightContexto`, adicionar os dois campos.

Run de novo: `npm run typecheck && npx jest src/modules/lead-insights/insight-prompt.spec.ts`
Expected: limpo e PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/lead-insights/
git commit -m "feat(api): prompt da ficha IA recebe cadastro/formulario e tem modo pre-contato"
```

---

### Task 9: `LeadInsightsService` — cadastro no contexto, geração sem mensagens, `enfileirarImportado`

**Files:**
- Modify: `apps/api/src/modules/lead-insights/lead-insights.service.ts:1502-1660` (`gerarInsight`), `:892` (`enfileirar`)
- Test: `apps/api/src/modules/lead-insights/lead-insights.service.spec.ts`

**Interfaces:**
- Consumes: `InsightContexto.lead.origem/cadastro` (Task 8).
- Produces: `enfileirarImportado(leadId: string, tenantId: string): Promise<void>`; `gerarInsight` gera com zero mensagens quando há cadastro.

- [ ] **Step 1: Testes que falham**

Em `lead-insights.service.spec.ts`, no `montar()` acrescentar ao objeto `prisma`:

```ts
  const customFieldDef = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma = { leadInsight, message, lead, stage, leadActivity, leadLembrete, customFieldDef };
```

e devolver `customFieldDef` no return. Em `leadCompleto()` acrescentar defaults:

```ts
    email: null,
    empresa: null,
    origem: 'WHATSAPP_INCOMING',
    dados_custom: {},
    attribution: null,
```

Novos testes:

```ts
describe('LeadInsightsService.gerarInsight — cadastro e pré-contato', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T13:00:00Z')); // terça, 10:00 BRT
  });
  afterEach(() => jest.useRealTimers());

  it('lead sem mensagens e sem cadastro: não chama o modelo', async () => {
    const m = montar();
    m.lead.findFirst.mockResolvedValue(leadCompleto());
    m.message.findMany.mockResolvedValue([]);
    await m.service.gerarInsight('lead-1', 't1');
    expect(m.ai.chat).not.toHaveBeenCalled();
    expect(m.leadInsight.upsert).not.toHaveBeenCalled();
  });

  it('lead importado sem mensagens mas com formulário: gera ficha pré-contato, watermark null, próxima ação hoje', async () => {
    const m = montar();
    m.lead.findFirst.mockResolvedValue(
      leadCompleto({
        origem: 'IMPORT',
        email: 'e@x.com',
        dados_custom: { tipo_empresa: 'MEI', producao_mensal: '500 mil', vazio: '' },
        attribution: { utm_campaign: '[LEADS] V3', campaign_name: null },
      }),
    );
    m.customFieldDef.findMany.mockResolvedValue([
      { key: 'tipo_empresa', nome: 'Tipo de empresa' },
      { key: 'producao_mensal', nome: 'Produção mensal' },
    ]);
    m.message.findMany.mockResolvedValue([]);
    m.leadInsight.findUnique.mockResolvedValue(null);
    m.ai.chat.mockResolvedValue({ text: RESPOSTA_OK, tokensIn: 10, tokensOut: 20 });

    await m.service.gerarInsight('lead-1', 't1');

    const [req] = m.ai.chat.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    const user = req.messages[1].content;
    expect(user).toContain('## Cadastro e formulário');
    expect(user).toContain('- E-mail: e@x.com');
    expect(user).toContain('- Tipo de empresa: MEI');
    expect(user).toContain('- Produção mensal: 500 mil');
    expect(user).toContain('- Campanha: [LEADS] V3');
    expect(user).not.toContain('vazio');
    expect(user).toContain('AINDA NAO HOUVE CONVERSA');

    const [args] = m.leadInsight.upsert.mock.calls[0] as [{ create: Record<string, unknown> }];
    expect(args.create.ultima_msg_processada_at).toBeNull();
    // Pré-contato: próxima ação é AGORA ajustada à janela comercial (10:00 BRT de terça já está dentro).
    expect(args.create.proxima_acao_at).toEqual(new Date('2026-09-08T13:00:00Z'));
    // Sem watermark não há "novidade durante a geração" para rechecar.
    expect(m.message.count).not.toHaveBeenCalled();
  });

  it('lead com conversa E cadastro: bloco de cadastro entra, mas o fluxo continua o normal (watermark = última msg)', async () => {
    const m = montar();
    m.lead.findFirst.mockResolvedValue(leadCompleto({ dados_custom: { cidade: 'Curitiba' } }));
    m.customFieldDef.findMany.mockResolvedValue([{ key: 'cidade', nome: 'Cidade' }]);
    m.message.findMany.mockResolvedValue([
      { direction: 'INCOMING', type: 'TEXT', content: 'oi', created_at: new Date('2026-09-08T12:00:00Z') },
    ]);
    m.leadInsight.findUnique.mockResolvedValue(null);
    m.ai.chat.mockResolvedValue({ text: RESPOSTA_OK, tokensIn: 10, tokensOut: 20 });
    m.message.count.mockResolvedValue(0);

    await m.service.gerarInsight('lead-1', 't1');

    const [req] = m.ai.chat.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    expect(req.messages[1].content).toContain('- Cidade: Curitiba');
    expect(req.messages[1].content).not.toContain('AINDA NAO HOUVE CONVERSA');
    const [args] = m.leadInsight.upsert.mock.calls[0] as [{ create: Record<string, unknown> }];
    expect(args.create.ultima_msg_processada_at).toEqual(new Date('2026-09-08T12:00:00Z'));
  });
});

describe('LeadInsightsService.enfileirarImportado', () => {
  it('enfileira gerar com jobId lead-<id> e delay do gatilho', async () => {
    const m = montar();
    await m.service.enfileirarImportado('lead-9', 't1');
    expect(m.queue.add).toHaveBeenCalledWith(
      'gerar',
      { leadId: 'lead-9', tenantId: 't1' },
      expect.objectContaining({ jobId: 'lead-lead-9', delay: 2 * 60 * 1000 }),
    );
  });
});
```

`RESPOSTA_OK` já existe no spec (fixture do JSON do modelo).

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd apps/api && npx jest src/modules/lead-insights/lead-insights.service.spec.ts -t "cadastro|enfileirarImportado"`
Expected: FAIL — `enfileirarImportado` ausente (se a Task 6 não criou o stub) e ficha não gerada sem mensagens.

- [ ] **Step 3: Implementar**

(a) Método público, perto de `enfileirarSeElegivel`:

```ts
  /**
   * Lead que nasceu de importação (planilha Meta Lead Ads): não há mensagem
   * para disparar o gatilho normal, então a importação pede a ficha
   * diretamente. Mesmo jobId `lead-<id>` do gatilho: se a pessoa mandar
   * mensagem nesse meio-tempo, os dois pedidos viram um só.
   */
  async enfileirarImportado(leadId: string, tenantId: string): Promise<void> {
    await this.enfileirar(leadId, tenantId, `lead-${leadId}`, ATRASO_GATILHO_MS);
  }
```

(b) Em `gerarInsight`, ampliar o `select` do lead:

```ts
        email: true,
        empresa: true,
        origem: true,
        dados_custom: true,
        attribution: { select: { utm_campaign: true, campaign_name: true } },
```

(c) Trocar `if (recentes.length === 0) return;` por:

```ts
    const cadastro = await this.montarCadastro(tenantId, {
      email: lead.email,
      empresa: lead.empresa,
      dados_custom: lead.dados_custom,
      campanha: lead.attribution?.campaign_name ?? lead.attribution?.utm_campaign ?? null,
    });
    // Sem conversa E sem cadastro nao ha o que analisar. Com cadastro, a ficha
    // pre-contato (perfil + abordagem) e justamente o que a importacao pede.
    if (recentes.length === 0 && cadastro.length === 0) return;
    const preContato = recentes.length === 0;
```

(d) No `contexto.lead` acrescentar `origem: String(lead.origem), cadastro,` (remover o placeholder da Task 8).

(e) Watermark e próxima ação:

```ts
    const watermark: Date | null = mensagens.length > 0 ? mensagens[mensagens.length - 1].created_at : null;
    const baseProximaAcao = preContato ? Date.now() : Date.now() + insight.proxima_acao_em_dias * DIA;
    const proximaAcao = ajustarParaJanela(new Date(baseProximaAcao), lead.tenant);
```

`ultima_msg_processada_at: watermark` já aceita null (coluna nullable). No fim, trocar `await this.rechecarNovidade(leadId, tenantId, watermark);` por `if (watermark !== null) await this.rechecarNovidade(leadId, tenantId, watermark);`.

(f) Método privado novo:

```ts
  /**
   * Linhas "rotulo: valor" do cadastro para o prompt. Campos custom entram com
   * o rotulo do tenant (CustomFieldDef.nome) em vez da chave; nativos (native_key)
   * ficam de fora porque ja aparecem em "Dados do lead". Valor vazio nao entra.
   */
  private async montarCadastro(
    tenantId: string,
    lead: { email: string | null; empresa: string | null; dados_custom: unknown; campanha: string | null },
  ): Promise<Array<{ rotulo: string; valor: string }>> {
    const itens: Array<{ rotulo: string; valor: string }> = [];
    if (lead.email) itens.push({ rotulo: 'E-mail', valor: lead.email });
    if (lead.empresa) itens.push({ rotulo: 'Empresa', valor: lead.empresa });

    const dados =
      lead.dados_custom && typeof lead.dados_custom === 'object' && !Array.isArray(lead.dados_custom)
        ? (lead.dados_custom as Record<string, unknown>)
        : {};
    const chaves = Object.keys(dados);
    if (chaves.length > 0) {
      const defs = await this.prisma.customFieldDef.findMany({
        where: { tenant_id: tenantId, escopo: 'LEAD', native_key: null, key: { in: chaves } },
        select: { key: true, nome: true },
        orderBy: { ordem: 'asc' },
      });
      for (const d of defs) {
        const v = dados[d.key];
        const texto = typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.map(String).join(', ') : '';
        if (texto !== '') itens.push({ rotulo: d.nome, valor: texto });
      }
    }
    if (lead.campanha) itens.push({ rotulo: 'Campanha', valor: lead.campanha });
    return itens;
  }
```

- [ ] **Step 4: Rodar tudo do módulo e typecheck**

Run: `cd apps/api && npx jest src/modules/lead-insights && npm run typecheck`
Expected: PASS em todos (os testes antigos de `gerarInsight` continuam verdes: `customFieldDef.findMany` devolve `[]` por default e `leadCompleto` traz `dados_custom: {}`).

Se algum teste antigo quebrar por `prisma.customFieldDef` indefinido em outro `montar()`, é porque o spec tem mais de uma fábrica: adicionar o mock lá também.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/lead-insights/
git commit -m "feat(api): ficha IA pre-contato — cadastro no prompt, geracao sem mensagens e enfileirarImportado"
```

---

### Task 10: Envs no compose, `.env.example`, CLAUDE.md e checklist de deploy

**Files:**
- Modify: `docker-compose.yml` (bloco `environment` do `crm-backend`, após `LEAD_INSIGHTS_CONCURRENCY`)
- Modify: `.env.example`
- Modify: `CLAUDE.md` (seção nova curta)

- [ ] **Step 1: docker-compose**

```yaml
      # Importação da planilha Meta Lead Ads (modules/sheet-import). Um tenant
      # por env; sem TENANT_ID/SHEET_ID o módulo fica inerte.
      - SHEET_IMPORT_TENANT_ID=${SHEET_IMPORT_TENANT_ID:-}
      - SHEET_IMPORT_SHEET_ID=${SHEET_IMPORT_SHEET_ID:-}
      - SHEET_IMPORT_GID=${SHEET_IMPORT_GID:-}
      - SHEET_IMPORT_PIPELINE_ID=${SHEET_IMPORT_PIPELINE_ID:-}
      - SHEET_IMPORT_STAGE_ID=${SHEET_IMPORT_STAGE_ID:-}
```

- [ ] **Step 2: .env.example**

```
# Importação da planilha Meta Lead Ads (um tenant). Vazio = desligado.
SHEET_IMPORT_TENANT_ID=
SHEET_IMPORT_SHEET_ID=
SHEET_IMPORT_GID=
SHEET_IMPORT_PIPELINE_ID=
SHEET_IMPORT_STAGE_ID=
```

- [ ] **Step 3: CLAUDE.md**

Acrescentar após a seção "IA nativa":

```markdown
## Importação de planilha Meta Lead Ads (set/2026)
- `apps/api/src/modules/sheet-import/`: cron 5 min + rodada no boot lê o CSV público
  da planilha (`SHEET_IMPORT_SHEET_ID`) para UM tenant (`SHEET_IMPORT_TENANT_ID`).
  Dedupe por linha em `SheetImportRow` e por telefone (`telefone_pipeline_scope`).
  Lead nasce `origem=IMPORT`, sem dono, etapa base, campos no grupo "Formulário Meta",
  tags MEI/Pessoa Física, atribuição Meta Ads, e enfileira Ficha IA pré-contato.
- Ficha IA gera SEM mensagens quando o lead tem cadastro (`montarCadastro`).
- Spec: `docs/superpowers/specs/2026-09-08-importacao-planilha-meta-design.md`.
```

- [ ] **Step 4: Rodar a suíte inteira do backend**

Run: `cd apps/api && npx jest 2>&1 | tail -15`
Expected: todos os suites verdes (ou só falhas pré-existentes já conhecidas; anotar quais).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example CLAUDE.md
git commit -m "chore: envs da importacao da planilha Meta no compose, .env.example e CLAUDE.md"
```

---

### Task 11: Deploy e verificação em produção (manual, com o Yuri)

Não é código; é o roteiro. Precisa do SSH da VPS (`/c/WINDOWS/System32/OpenSSH/ssh.exe crm-vps`, ver memória `crm-vps-ssh-windows-agent`).

- [ ] **Step 1: Merge e push**

```bash
git checkout master && git merge --no-ff feat/importacao-planilha-meta && git push origin master
```

- [ ] **Step 2: Envs no VPS**

No `/opt/crm-whatsapp/.env` acrescentar:

```
SHEET_IMPORT_TENANT_ID=a44772ed-1382-4400-84fc-3fa350e23e42
SHEET_IMPORT_SHEET_ID=1nh4sxh7LHDJYRMEW_r9IC47ebGCTWElmKo7enjPCRQc
```

(pipeline `4321b42f-670c-418e-8121-463446b0694a` e etapa Novo `e1676a27-c392-4a95-8666-86d914fd0478` são os defaults resolvidos; não precisa setar.)

- [ ] **Step 3: Migration**

```bash
cd /opt/crm-whatsapp && git pull origin master && cd apps/api && npm install --omit=dev && npx prisma generate
set -a && . /opt/crm-whatsapp/.env && set +a
node scripts/apply-sheet-import.mjs --dry-run
node scripts/apply-sheet-import.mjs
node ../../node_modules/prisma/build/index.js migrate resolve --applied 20260908120000_sheet_import_row
```

Expected: `OK — nenhuma tabela existente tocada, tabelas novas criadas e vazias.`

- [ ] **Step 4: Build e subir**

```bash
cd /opt/crm-whatsapp && docker compose build crm-backend && docker compose up -d && sleep 20 && docker logs crm-backend --since 2m | grep -i "importa"
```

Expected: `Importação da planilha: 128 linhas, 123 novas, 0 anexadas, 5 puladas, 0 erros` (números podem variar se a agência já adicionou linhas; anexadas > 0 se algum telefone já existia).

- [ ] **Step 5: Conferência funcional**

- Kanban da Taynara: coluna Novo com os leads, tag `MEI`/`Pessoa Física` nos cards certos.
- Abrir um lead: grupo "Formulário Meta" com os campos preenchidos; timeline com a atividade "Importado da planilha de leads (Meta Lead Ads). ...".
- Lista de leads: filtro origem "Importação" devolve os importados.
- Relatório de origem (Atribuição): canal Meta Ads com as campanhas.
- Fila: `docker logs crm-backend | grep -c "Insight do lead"` crescendo; abrir 2–3 fichas depois de alguns minutos e ler o texto pré-contato.
- 5 minutos depois: log `Planilha sem mudanças` (nível debug; se LOG_LEVEL=info, não aparece — conferir que não houve nova linha "Importação da planilha:" com novas > 0).

- [ ] **Step 6: Registrar estado na memória do Claude**

Atualizar/criar memória `crm-importacao-planilha-meta-estado.md` com commit deployado, o que foi conferido e o que ficou pendente.

---

## Self-review

**Spec coverage**
- Módulo `sheet-import` (parser puro, service, cron, boot): Tasks 1, 2, 5, 6, 7. ✔
- Tabela `SheetImportRow` sem FK, migration manual: Task 3. ✔
- Config por env com defaults de pipeline/etapa base/instância: Task 5. ✔
- Dedupe por linha e por telefone; anexar em lead existente sem mudar etapa/dono: Tasks 6, 7. ✔
- Linhas de teste e telefone inválido → `skipped` com motivo: Task 7. ✔
- Retentativa até 3 em `error`: Task 7. ✔
- Hash do CSV, nada em disco, só memória: Task 7. ✔
- Detecção de planilha privada (HTML de login): Task 7. ✔
- Lead novo: origem IMPORT, FRIO, sem dono, topo da coluna, instância, tags Json + LeadTag, atividade legível, WS, atribuição Meta: Task 6. ✔ (`ig`/`fb`/`meta` já estão em `META_SOURCES`, `paid` em `PAID_MEDIUMS` — verificado no código; nada a acrescentar.)
- Campos custom grupo "Formulário Meta" idempotentes: Tasks 2, 4, 5. ✔
- Perguntas por header exato com fallback por posição; extras só no texto: Task 2. ✔
- Ficha IA: bloco cadastro, pré-contato sem mensagens, watermark null, `enfileirarImportado`, lead anexado não reenfileira: Tasks 8, 9, 6. ✔
- Envs no compose/.env.example/CLAUDE.md e roteiro de deploy: Tasks 10, 11. ✔

**Placeholder scan**: nenhum "TBD/TODO"; todo passo de código tem o código. A única dependência cruzada (Task 6 usa `enfileirarImportado` da Task 9) está resolvida com o stub explícito na Task 6.

**Type consistency**: `ImportedLead`, `MapResult`, `RunContext`, `RunSummary`, `processRow(): 'created' | 'attached'`, `enfileirarImportado(leadId, tenantId)`, `ensureTenantBootstrap(tenantId)`, `InsightContexto.lead.origem/cadastro` usados com os mesmos nomes em todas as tasks.
