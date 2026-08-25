# Views salvas de leads (tabela + kanban) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Views nomeadas por usuário (colunas + filtros + ordenação + modo) valendo num modo Lista novo (`/leads`) e no kanban existente.

**Architecture:** `LeadView` estendida com 4 colunas Json sanitizadas (sem tabela nova). Config hidratada por lib pura no front (padrão `lead-filters.ts`). `ViewBar` compartilhada com estado sujo (mexer nunca grava; `Salvar/Descartar/Salvar como nova`). `GET /api/leads` ganha sort por whitelist. Spec: `docs/superpowers/specs/2026-08-25-lead-views-design.md`.

**Tech Stack:** NestJS + Prisma (Supabase PG), Jest/ts-jest; Next.js 14 + TanStack Query + shadcn + Tailwind; jest do web só cobre `lib/`.

## Global Constraints

- NUNCA `prisma migrate deploy`/`db push` (banco poluído P3009). Migration = SQL manual em `apps/api/prisma/manual/`, aplicada no deploy via node+Prisma no container (runbook da Task 8).
- NUNCA `any` no TypeScript. Input HTTP validado/sanitizado no service (padrão do módulo, sem Zod aqui — `lead-views` usa whitelist manual).
- Jest da API: rodar de `apps/api` com `npx jest <arquivo> --maxWorkers=2`. Jest do web: de `apps/web`, `npx jest --maxWorkers=2` (só `lib/*.spec.ts`). RAM da máquina é 16GB — SEMPRE `--maxWorkers=2`.
- Typecheck: `npx tsc --noEmit` nos dois apps. Front: `npm run build` antes de commitar tela nova.
- rtk hook quebra `npx prisma` — usar `node ../../node_modules/prisma/build/index.js ...`.
- Commits frequentes `feat(api):` / `feat(web):`.
- Domínios fixos: `tipo_padrao ∈ {'kanban','lista'}`; `sort.dir ∈ {'asc','desc'}`; `sort.campo` ordenável ∈ `['nome','created_at','ultima_interacao','valor_estimado','temperatura','proximo_followup']`; `width` 60–640.

---

### Task 1: Lib pura de config de view (web)

**Files:**
- Create: `apps/web/src/lib/lead-view-config.ts`
- Test: `apps/web/src/lib/lead-view-config.spec.ts`

**Interfaces:**
- Produces (consumidas pelas Tasks 5–7):
  - `type ViewMode = 'kanban' | 'lista'`
  - `interface ViewSort { campo: string; dir: 'asc' | 'desc' }`
  - `interface ViewColumn { key: string; width?: number }`
  - `interface LeadViewConfig { tipo_padrao: ViewMode; sort: ViewSort | null; colunas: ViewColumn[]; card_fields: string[] }`
  - `CONFIG_VAZIA: LeadViewConfig` (`{ tipo_padrao: 'kanban', sort: null, colunas: [], card_fields: [] }`)
  - `COLUNAS_DEFAULT: ViewColumn[]` — `[{key:'nome'},{key:'telefone'},{key:'estagio'},{key:'temperatura'},{key:'valor_estimado'},{key:'responsavel'},{key:'ultima_interacao'}]` (o que a tabela mostra sem view)
  - `fromSavedConfig(bruto: unknown): LeadViewConfig` — hidratação defensiva
  - `configIgual(a: LeadViewConfig, b: LeadViewConfig): boolean` — comparação profunda (JSON canônico), base do estado sujo

- [ ] **Step 1: Write the failing test**

```typescript
import { fromSavedConfig, configIgual, CONFIG_VAZIA } from './lead-view-config';

describe('fromSavedConfig', () => {
  it('json solto vira defaults', () => {
    expect(fromSavedConfig(null)).toEqual(CONFIG_VAZIA);
    expect(fromSavedConfig('lixo')).toEqual(CONFIG_VAZIA);
    expect(fromSavedConfig([])).toEqual(CONFIG_VAZIA);
  });

  it('hidrata config completa', () => {
    const c = fromSavedConfig({
      tipo_padrao: 'lista',
      sort: { campo: 'valor_estimado', dir: 'desc' },
      colunas: [{ key: 'nome', width: 240 }, { key: 'x_cnpj' }],
      card_fields: ['valor_estimado', 'tags'],
    });
    expect(c.tipo_padrao).toBe('lista');
    expect(c.sort).toEqual({ campo: 'valor_estimado', dir: 'desc' });
    expect(c.colunas).toEqual([{ key: 'nome', width: 240 }, { key: 'x_cnpj' }]);
    expect(c.card_fields).toEqual(['valor_estimado', 'tags']);
  });

  it('valor fora do domínio cai no default, sem derrubar o resto', () => {
    const c = fromSavedConfig({
      tipo_padrao: 'grafico',
      sort: { campo: 'nome', dir: 'sideways' },
      colunas: [{ key: '' }, { key: 'nome', width: 'larga' }, 42],
      card_fields: ['ok', 7, ''],
    });
    expect(c.tipo_padrao).toBe('kanban');
    expect(c.sort).toBeNull();
    expect(c.colunas).toEqual([{ key: 'nome' }]); // width inválida some, key vazia some
    expect(c.card_fields).toEqual(['ok']);
  });

  it('width clampada em 60..640', () => {
    const c = fromSavedConfig({ colunas: [{ key: 'a', width: 10 }, { key: 'b', width: 9000 }] });
    expect(c.colunas).toEqual([{ key: 'a', width: 60 }, { key: 'b', width: 640 }]);
  });
});

describe('configIgual', () => {
  it('igualdade profunda, ordem de colunas importa', () => {
    const a = fromSavedConfig({ colunas: [{ key: 'x' }, { key: 'y' }] });
    const b = fromSavedConfig({ colunas: [{ key: 'x' }, { key: 'y' }] });
    const c = fromSavedConfig({ colunas: [{ key: 'y' }, { key: 'x' }] });
    expect(configIgual(a, b)).toBe(true);
    expect(configIgual(a, c)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `cd apps/web && npx jest lead-view-config --maxWorkers=2` — Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run** `cd apps/web && npx jest lead-view-config --maxWorkers=2` — Expected: PASS. `npx tsc --noEmit` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/lead-view-config.ts apps/web/src/lib/lead-view-config.spec.ts
git commit -m "feat(web): lib pura de config de view salva (hidratacao defensiva + igualdade)"
```

---

### Task 2: Migration + schema — colunas novas em LeadView (api)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model LeadView, linhas ~659-672)
- Create: `apps/api/prisma/manual/2026-08-25-lead-view-config.sql`

**Interfaces:**
- Produces: `LeadView.tipo_padrao String`, `LeadView.sort Json`, `LeadView.colunas Json`, `LeadView.card_fields Json` no Prisma Client (Tasks 3+ dependem).

- [ ] **Step 1: Editar schema.prisma** — dentro do `model LeadView`, após `filtros    Json     @default("{}")`:

```prisma
  // Config da view (rodada Twenty). Defaults mantêm views antigas válidas.
  tipo_padrao String @default("kanban") // 'kanban' | 'lista'
  sort        Json   @default("{}")     // { campo, dir } — vazio = sem ordenação salva
  colunas     Json   @default("[]")     // tabela: [{ key, width? }] em ordem
  card_fields Json   @default("[]")     // kanban: chaves visíveis no card
```

- [ ] **Step 2: Criar a SQL manual** `apps/api/prisma/manual/2026-08-25-lead-view-config.sql`:

```sql
BEGIN;
ALTER TABLE "LeadView" ADD COLUMN IF NOT EXISTS "tipo_padrao" TEXT NOT NULL DEFAULT 'kanban';
ALTER TABLE "LeadView" ADD COLUMN IF NOT EXISTS "sort" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "LeadView" ADD COLUMN IF NOT EXISTS "colunas" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "LeadView" ADD COLUMN IF NOT EXISTS "card_fields" JSONB NOT NULL DEFAULT '[]';
COMMIT;
```

- [ ] **Step 3:** `cd apps/api && node ../../node_modules/prisma/build/index.js generate` — client novo compila.

- [ ] **Step 4:** `cd apps/api && npx tsc --noEmit` — Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/manual/2026-08-25-lead-view-config.sql
git commit -m "feat(api): colunas de config de view em LeadView (SQL manual, banco poluido)"
```

**Nota:** a SQL é aplicada no deploy (Task 8), não agora. Prisma tipa como `TIMESTAMP`? Não — são TEXT/JSONB; nada mais a fazer.

---

### Task 3: Sanitização e persistência da config no lead-views (api)

**Files:**
- Modify: `apps/api/src/modules/lead-views/lead-views.service.ts`
- Modify: `apps/api/src/modules/lead-views/lead-views.controller.ts` (interface `SalvarViewBody`)
- Test: `apps/api/src/modules/lead-views/lead-views.service.spec.ts` (acrescentar describes)

**Interfaces:**
- Consumes: colunas da Task 2; `NATIVE_FIELDS` de `../leads/field-schema`.
- Produces: `create`/`update` aceitam `{ tipo_padrao?, sort?, colunas?, card_fields? }` no body e gravam sanitizado. Chave de campo válida = `native_key` de `NATIVE_FIELDS.LEAD` + `key` de `CustomFieldDef` ativo do tenant (escopo LEAD) + pseudo-colunas de relação `['estagio','responsavel','tags','created_at','ultima_interacao','telefone']` (as que a tabela renderiza sem serem campo de ficha). Campos ordenáveis: `SORTABLE_FIELDS = ['nome','created_at','ultima_interacao','valor_estimado','temperatura','proximo_followup']` (exportar const).
- View compartilhada (`compartilhada: true` ou update de view `user_id null`): exigir role GERENTE ou SUPER_ADMIN — `ForbiddenException` caso contrário. (Hoje o controller não tem esse guard, apesar do comentário no service; esta task fecha o buraco no service, onde a autoria já é conferida.)

- [ ] **Step 1: Write the failing test** — abrir `lead-views.service.spec.ts` existente e COPIAR o padrão de construção do service/mock de prisma usado lá (não inventar outro). Acrescentar:

```typescript
// Ajustar makeService/mocks ao padrão real do arquivo. Precisa de:
// prisma.customFieldDef.findMany -> [{ key: 'x_cnpj' }]
// user GERENTE e user OPERADOR (shape do AuthUser usado no spec existente).

describe('sanitizacao da config de view', () => {
  it('grava config valida', async () => {
    const created = await service.create(gerente, {
      nome: 'Minha lista',
      tipo_padrao: 'lista',
      sort: { campo: 'valor_estimado', dir: 'desc' },
      colunas: [{ key: 'nome', width: 240 }, { key: 'x_cnpj' }, { key: 'estagio' }],
      card_fields: ['valor_estimado', 'tags'],
    });
    const data = prisma.leadView.create.mock.calls[0][0].data;
    expect(data.tipo_padrao).toBe('lista');
    expect(data.sort).toEqual({ campo: 'valor_estimado', dir: 'desc' });
    expect(data.colunas).toEqual([{ key: 'nome', width: 240 }, { key: 'x_cnpj' }, { key: 'estagio' }]);
    expect(data.card_fields).toEqual(['valor_estimado', 'tags']);
  });

  it('descarta chave desconhecida, sort fora da whitelist e clampa width', async () => {
    await service.create(gerente, {
      nome: 'Suja',
      tipo_padrao: 'grafico',
      sort: { campo: 'x_cnpj', dir: 'desc' }, // custom nao e ordenavel
      colunas: [{ key: 'nao_existe' }, { key: 'nome', width: 9000 }],
      card_fields: ['nao_existe', 'telefone'],
    });
    const data = prisma.leadView.create.mock.calls[0][0].data;
    expect(data.tipo_padrao).toBe('kanban');
    expect(data.sort).toEqual({});
    expect(data.colunas).toEqual([{ key: 'nome', width: 640 }]);
    expect(data.card_fields).toEqual(['telefone']);
  });
});

describe('view compartilhada exige gestor', () => {
  it('OPERADOR nao cria compartilhada', async () => {
    await expect(service.create(operador, { nome: 'Time', compartilhada: true })).rejects.toThrow('Apenas gestores');
  });
  it('OPERADOR nao edita view compartilhada', async () => {
    prisma.leadView.findFirst.mockResolvedValue({ id: 'v1', user_id: null });
    await expect(service.update(operador, 'v1', { nome: 'Novo' })).rejects.toThrow('Apenas gestores');
  });
  it('GERENTE pode', async () => {
    await expect(service.create(gerente, { nome: 'Time', compartilhada: true })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest lead-views --maxWorkers=2` — Expected: FAIL (campos ignorados / sem exceção).

- [ ] **Step 3: Implementar no service**

```typescript
// topo do arquivo:
import { ForbiddenException } from '@nestjs/common'; // juntar ao import existente
import { NATIVE_FIELDS } from '../leads/field-schema';

export const SORTABLE_FIELDS = ['nome', 'created_at', 'ultima_interacao', 'valor_estimado', 'temperatura', 'proximo_followup'] as const;

/** Colunas de relação/derivadas que a tabela sabe renderizar além dos campos de ficha. */
const PSEUDO_COLUNAS = ['estagio', 'responsavel', 'tags', 'created_at', 'ultima_interacao', 'telefone'] as const;

const GESTORES = ['GERENTE', 'SUPER_ADMIN'];

interface ConfigBody {
  tipo_padrao?: unknown;
  sort?: unknown;
  colunas?: unknown;
  card_fields?: unknown;
}

// dentro da classe:
private async chavesValidas(tenantId: string): Promise<Set<string>> {
  const defs = await this.prisma.customFieldDef.findMany({
    where: { tenant_id: tenantId, escopo: 'LEAD', active: true },
    select: { key: true },
  });
  return new Set([
    ...NATIVE_FIELDS.LEAD.map((f) => f.native_key),
    ...defs.map((d) => d.key),
    ...PSEUDO_COLUNAS,
  ]);
}

private sanitizarConfig(body: ConfigBody, validas: Set<string>) {
  const tipo_padrao = body.tipo_padrao === 'lista' ? 'lista' : 'kanban';

  let sort: Prisma.InputJsonObject = {};
  if (body.sort && typeof body.sort === 'object' && !Array.isArray(body.sort)) {
    const s = body.sort as Record<string, unknown>;
    if (
      typeof s.campo === 'string' &&
      (SORTABLE_FIELDS as readonly string[]).includes(s.campo) &&
      (s.dir === 'asc' || s.dir === 'desc')
    ) {
      sort = { campo: s.campo, dir: s.dir };
    }
  }

  const colunas: Array<{ key: string; width?: number }> = [];
  if (Array.isArray(body.colunas)) {
    for (const c of body.colunas) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const col = c as Record<string, unknown>;
      if (typeof col.key !== 'string' || !validas.has(col.key)) continue;
      const width =
        typeof col.width === 'number' && Number.isFinite(col.width)
          ? Math.min(640, Math.max(60, Math.round(col.width)))
          : undefined;
      colunas.push(width !== undefined ? { key: col.key, width } : { key: col.key });
    }
  }

  const card_fields = Array.isArray(body.card_fields)
    ? body.card_fields.filter((v): v is string => typeof v === 'string' && validas.has(v))
    : [];

  return { tipo_padrao, sort, colunas: colunas as unknown as Prisma.InputJsonArray, card_fields: card_fields as unknown as Prisma.InputJsonArray };
}

private exigirGestor(user: AuthUser) {
  if (!GESTORES.includes(user.role)) {
    throw new ForbiddenException('Apenas gestores podem gerenciar views compartilhadas');
  }
}
```

Em `create`: tipar body como `{ nome?: string; filtros?: unknown; compartilhada?: boolean } & ConfigBody`; se `body.compartilhada` → `this.exigirGestor(user)`; montar `data` com `...this.sanitizarConfig(body, await this.chavesValidas(user.tenantId))`.

Em `update`: mesmo body; `buscarEditavel` passa a selecionar `user_id` também, e se `view.user_id === null` → `this.exigirGestor(user)`. Para cada campo de config presente no body (`!== undefined`), aplicar o valor sanitizado correspondente (sanitizar uma vez e espalhar só as chaves presentes). Em `remove`: view compartilhada também exige gestor (mesma regra de edição).

Controller: estender `SalvarViewBody` com `tipo_padrao?: unknown; sort?: unknown; colunas?: unknown; card_fields?: unknown;` (sem mudança de rota).

- [ ] **Step 4: Run** `cd apps/api && npx jest lead-views --maxWorkers=2` + `npx tsc --noEmit` — Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/lead-views/
git commit -m "feat(api): config de view sanitizada (colunas/sort/card_fields) + guard de gestor em view compartilhada"
```

---

### Task 4: Ordenação por whitelist na listagem de leads (api)

**Files:**
- Create: `apps/api/src/modules/leads/lead-sort.ts`
- Test: `apps/api/src/modules/leads/lead-sort.spec.ts`
- Modify: `apps/api/src/modules/leads/leads.service.ts` (interface `LeadFilters` ~l.157; `leadListSelect` ~l.433; `runQuery` orderBy ~l.485)

**Interfaces:**
- Consumes: nada de tasks anteriores (função pura + fios no service).
- Produces: `GET /api/leads?sort=<campo>&dir=<asc|desc>` ordena a lista plena; `buildSortOrder(sort?: string, dir?: string): Prisma.LeadOrderByWithRelationInput | null` exportada. Resposta da listagem passa a incluir `email`, `empresa`, `cargo`, `dados_custom` (a tabela da Task 6 lê).

- [ ] **Step 1: Write the failing test**

```typescript
import { buildSortOrder } from './lead-sort';

describe('buildSortOrder', () => {
  it('campo da whitelist vira orderBy com nulls last', () => {
    expect(buildSortOrder('valor_estimado', 'desc')).toEqual({ valor_estimado: { sort: 'desc', nulls: 'last' } });
    expect(buildSortOrder('nome', 'asc')).toEqual({ nome: 'asc' });
    expect(buildSortOrder('created_at', 'asc')).toEqual({ created_at: 'asc' });
  });

  it('fora da whitelist ou dir invalida -> null (ordenacao padrao)', () => {
    expect(buildSortOrder('dados_custom', 'asc')).toBeNull();
    expect(buildSortOrder('valor_estimado', 'up')).toBeNull();
    expect(buildSortOrder(undefined, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest lead-sort --maxWorkers=2` — Expected: FAIL (module not found).

- [ ] **Step 3: Implementar**

```typescript
import type { Prisma } from '@prisma/client';

/**
 * Ordenação da lista de leads vinda da query string. Whitelist fechada:
 * campo fora dela NÃO é erro — cai na ordenação padrão da tela, porque uma
 * view salva com sort antigo tem que continuar abrindo.
 */
const NULLABLE_SORT = ['ultima_interacao', 'valor_estimado', 'temperatura', 'proximo_followup'] as const;
const PLAIN_SORT = ['nome', 'created_at'] as const;

export function buildSortOrder(sort?: string, dir?: string): Prisma.LeadOrderByWithRelationInput | null {
  if (dir !== 'asc' && dir !== 'desc') return null;
  if ((PLAIN_SORT as readonly string[]).includes(sort ?? '')) {
    return { [sort as string]: dir } as Prisma.LeadOrderByWithRelationInput;
  }
  if ((NULLABLE_SORT as readonly string[]).includes(sort ?? '')) {
    return { [sort as string]: { sort: dir, nulls: 'last' } } as Prisma.LeadOrderByWithRelationInput;
  }
  return null;
}
```

Fios no `leads.service.ts`:

1. `LeadFilters` ganha `sort?: string;` e `dir?: string;` (com comentário `/** Ordenação da lista (Task views salvas): whitelist em lead-sort.ts. */`).
2. `leadListSelect` ganha `email: true, empresa: true, cargo: true, dados_custom: true,` (depois de `tags: true`).
3. No `runQuery`, antes do `orderBy` atual: `const userSort = buildSortOrder(filters.sort, filters.dir);` e o orderBy vira:

```typescript
        orderBy: userSort
          ? [userSort, ...recencyOrder]
          : filters.scope === 'chat'
            ? [...recencyOrder]
            : filters.estagio_id || filters.per_stage
              ? [...boardOrder]
              : [{ estagio_id: 'asc' }, ...boardOrder],
```

(`userSort` vale também no kanban janelado — é o sort-dentro-da-coluna da Task 7.)
4. Conferir `buildLeadsListKey`: se ele serializa o objeto `filters` inteiro, nada a fazer; se lista chaves uma a uma, ACRESCENTAR `sort` e `dir` — sort fora da chave de cache devolveria lista ordenada errada do cache.

- [ ] **Step 4: Run** `cd apps/api && npx jest lead-sort leads --maxWorkers=2` + `npx tsc --noEmit` — Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/leads/
git commit -m "feat(api): ordenacao por whitelist na listagem de leads + campos de tabela no select"
```

---

### Task 5: Hook de view ativa + ViewBar com estado sujo (web)

**Files:**
- Create: `apps/web/src/components/leads/use-lead-view.ts`
- Create: `apps/web/src/components/leads/view-bar.tsx`

**Interfaces:**
- Consumes: Task 1 (`LeadViewConfig`, `fromSavedConfig`, `configIgual`, `CONFIG_VAZIA`); `LeadPanelFilters`/`FILTROS_VAZIOS`/`fromSaved`/`contarFiltrosAtivos` de `@/lib/lead-filters`; endpoints `/api/lead-views` (Task 3).
- Produces (Tasks 6–7 consomem):

```typescript
export interface LeadViewDto {
  id: string; nome: string; user_id: string | null;
  filtros: unknown; tipo_padrao: string; sort: unknown; colunas: unknown; card_fields: unknown;
}
export interface UseLeadView {
  views: LeadViewDto[];
  activeView: LeadViewDto | null;          // null = sem view
  selectView: (id: string | null) => void; // troca e reseta estado sujo
  filters: LeadPanelFilters;               // estado corrente (sujo ou salvo)
  setFilters: (f: LeadPanelFilters) => void;
  config: LeadViewConfig;                  // idem
  setConfig: (c: LeadViewConfig) => void;
  dirty: boolean;
  save: () => void;                        // PATCH na view ativa
  saveAs: (nome: string, compartilhada: boolean) => void; // POST
  discard: () => void;
  canEditActive: boolean;                  // view pessoal minha, ou compartilhada sendo eu gestor
}
export function useLeadView(): UseLeadView
export function ViewBar(props: {
  view: UseLeadView;
  mode: 'lista' | 'kanban';                // realce do toggle
  onOpenFilters: () => void;               // abre o painel de filtros da tela
}): JSX.Element
```

- [ ] **Step 1: Implementar `use-lead-view.ts`** (sem teste unitário — projeto web só testa `lib/`; a lógica pura já está na Task 1):

Comportamento exigido:
- `useQuery({ queryKey: ['lead-views'] })` em `GET /api/lead-views` (mesma queryKey já usada pelo `lead-filter-panel` — cache compartilhado).
- Estado local: `activeViewId` (inicial de `localStorage.getItem('crm.leadView')` dentro de try/catch), `filters`, `config`.
- `selectView(id)`: acha a view, seta `filters = fromSaved(view.filtros)`, `config = fromSavedConfig(view)` (a view DTO carrega os 4 campos no topo — passar o objeto view inteiro para `fromSavedConfig`, que só lê as chaves que conhece), grava id no localStorage (try/catch). `null` → `FILTROS_VAZIOS`/`CONFIG_VAZIA`.
- `dirty`: `activeView != null && (!configIgual(config, fromSavedConfig(activeView)) || JSON.stringify(filters) !== JSON.stringify(fromSaved(activeView.filtros)))`. Sem view ativa, `dirty` é sempre false (não há onde salvar; `saveAs` continua disponível).
- `save`: `api.patch('/api/lead-views/'+id, { filtros: toBody(filters), ...config, sort: config.sort ?? {} })` e invalida `['lead-views']`. `toBody` = objeto `filters` direto (o service sanitiza).
- `saveAs`: `api.post('/api/lead-views', { nome, compartilhada, filtros, ...config, sort: config.sort ?? {} })`, invalida e seleciona a criada (`onSuccess` devolve a view).
- `discard`: re-hidrata de `activeView`.
- View ativa sumiu da lista após refetch (deletada por outro usuário): efeito detecta e chama `selectView(null)` + `toast('View removida')`.
- `canEditActive`: view pessoal (`user_id === meu id`, via `useAuthStore`) ou compartilhada com meu role em `['GERENTE','SUPER_ADMIN']`.

- [ ] **Step 2: Implementar `view-bar.tsx`**:

Barra horizontal (padrão visual das tabs de `/admin/tenants`): dropdown de views (shadcn `DropdownMenu` — grupos "Minhas" e "Compartilhadas", check na ativa, item "Sem view"), toggle Lista/Kanban (dois botões-ícone `List`/`Columns3` de lucide; navegam via `next/link` para `/leads` e `/kanban` — a view ativa persiste porque o id está no localStorage e o hook roda nas duas telas), botão "Filtros" com badge `contarFiltrosAtivos(filters)` chamando `onOpenFilters`, e — quando `dirty` — grupo `Salvar` (se `canEditActive`) · `Descartar` · `Salvar como nova` (abre `Dialog` pequeno com input de nome + checkbox "Compartilhada com o time" visível só para gestor; role vem de `useAuthStore`).

- [ ] **Step 3: Verificar** — `cd apps/web && npx tsc --noEmit` — Expected: exit 0 (build completo fica para a Task 6, quando a ViewBar entra numa página).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/leads/
git commit -m "feat(web): hook de view ativa com estado sujo + ViewBar compartilhada"
```

---

### Task 6: Modo Lista — `/leads` (web)

**Files:**
- Create: `apps/web/src/app/(dashboard)/leads/page.tsx`
- Create: `apps/web/src/components/leads/lead-table.tsx`
- Create: `apps/web/src/components/leads/column-menu.tsx`
- Modify: item "Leads" na navegação — conferir `apps/web/src/components/layout/` (sidebar) e adicionar link `/leads` com ícone `List` ao lado do Kanban.

**Interfaces:**
- Consumes: Task 5 (`useLeadView`, `ViewBar`), Task 1 (`COLUNAS_DEFAULT`, `ViewColumn`), Task 4 (query `sort`/`dir` + campos novos na resposta), `GET /api/custom-fields` (defs, p/ rótulos e tipos), `toQueryParams` de `@/lib/lead-filters`, `lead-detail-drawer` do kanban.
- Produces: rota `/leads` funcional.

- [ ] **Step 1: `page.tsx`** — client component:

- `const view = useLeadView();`
- Leads: `useQuery({ queryKey: ['leads-lista', page, params], queryFn: GET /api/leads })` com `params = { ...toQueryParams(view.filters), ...(view.config.sort ? { sort: view.config.sort.campo, dir: view.config.sort.dir } : {}), limit: '50', offset: String(page*50) }`.
- Defs de campos: `useQuery({ queryKey: ['custom-fields'], queryFn: GET /api/custom-fields })` → mapa `key → { nome, tipo }` (nativos via `native_key`, customizados via `key`; a resposta traz os dois — conferir shape real ao implementar, o service é `custom-fields.service.ts#list`).
- Layout: `<ViewBar view={view} mode="lista" onOpenFilters={() => setPanelOpen(true)} />` + `<LeadFilterPanel value={view.filters} onChange={view.setFilters} />` (mesmo painel do kanban — conferir props reais; ele é Dialog com `value`/`onChange`) + `<LeadTable ... />` + paginação (Anterior/Próxima; desabilita Próxima quando a página veio com <50 linhas).
- Clique na linha: estado `openLeadId` → renderiza o `lead-detail-drawer` (conferir props reais do componente no kanban e replicar o uso).

- [ ] **Step 2: `lead-table.tsx`**:

```typescript
interface LeadTableProps {
  leads: LeadRow[];                 // shape da listagem da API (tipar os campos usados)
  colunas: ViewColumn[];            // vazio -> COLUNAS_DEFAULT
  fieldDefs: Map<string, { nome: string; tipo: string }>;
  onRowClick: (id: string) => void;
  onColumnsChange: (c: ViewColumn[]) => void; // resize/reorder/hide -> view.setConfig
}
```

- Render: `<table>` no padrão visual de `/admin/tenants` (mesmas classes/vars CSS). Header: rótulo do campo (de `fieldDefs`, fallback: a própria key), alça de resize na borda direita (mouse events, atualiza `width` no mouseup via `onColumnsChange`).
- Célula por tipo: `currency` → `Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'})`; `date`/datas → `toLocaleDateString('pt-BR')`; `temperatura` → badge colorida (FRIO cinza/MORNO amarelo/QUENTE laranja/MUITO_QUENTE vermelho); `tags` → chips (dados vêm de `lead_tags[].tag`); `estagio` → nome com bolinha `estagio.cor`; `responsavel` → nome; campo custom → `lead.dados_custom?.[key]` formatado pelo tipo do def; `multiselect` → join ', '; `boolean` → 'Sim'/'Não'; default → texto cru.
- `overflow-x-auto` no wrapper; `min-width` por coluna = width salvo ou 160.

- [ ] **Step 3: `column-menu.tsx`** — popover "Colunas" na ViewBar ou no header da tabela (decisão: header da tabela, à direita): busca (Input), lista de todos os campos (nativos + customs + pseudo) com olho (Eye/EyeOff) para incluir/excluir e drag (reuso de `@dnd-kit/sortable`, já é dependência do kanban) para reordenar as visíveis. Emite `onColumnsChange`.

- [ ] **Step 4: Navegação** — achar o array de itens da sidebar em `apps/web/src/components/layout/` (grep por `Kanban` ou `href: '/kanban'`) e inserir `{ label: 'Leads', href: '/leads', icon: List }` adjacente ao Kanban.

- [ ] **Step 5: Verificar** — `cd apps/web && npx tsc --noEmit && npm run build` — Expected: exit 0 nos dois.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(dashboard)/leads/" apps/web/src/components/leads/ apps/web/src/components/layout/
git commit -m "feat(web): modo Lista de leads com colunas configuraveis, ordenacao e paginacao"
```

---

### Task 7: Kanban lê a view ativa (web)

**Files:**
- Modify: `apps/web/src/app/(dashboard)/kanban/page.tsx` (estado de filtros ~l.221-222, render do painel ~l.942)
- Modify: `apps/web/src/components/kanban/lead-card.tsx` (props ~l.113)

**Interfaces:**
- Consumes: Task 5 (`useLeadView`, `ViewBar`), Task 4 (`sort`/`dir` na query).
- Produces: kanban com ViewBar; cards refletindo `card_fields`.

- [ ] **Step 1: Trocar o estado local de filtros pela view** em `kanban/page.tsx`:

- `const view = useLeadView();` no topo do componente.
- Substituir `const [panelFilters, setPanelFilters] = useState<LeadPanelFilters>(FILTROS_VAZIOS);` por `const panelFilters = view.filters;` e `setPanelFilters` por `view.setFilters` (o `<LeadFilterPanel value onChange>` da l.942 passa a receber os do hook).
- Nos params da query de leads (onde `panelParams` entra), acrescentar `...(view.config.sort ? { sort: view.config.sort.campo, dir: view.config.sort.dir } : {})` — o backend (Task 4) já aplica isso dentro da janela por coluna.
- Renderizar `<ViewBar view={view} mode="kanban" onOpenFilters={...} />` acima do board, ao lado dos controles existentes (pipeline-switcher) — abrir o LeadFilterPanel é o mesmo estado booleano que o botão de filtros atual usa; conferir o nome do estado no arquivo e reusar.

- [ ] **Step 2: `card_fields` no LeadCard**:

- `LeadCardProps` ganha `cardFields?: string[]` (vazio/undefined = card padrão, zero mudança visual).
- No corpo do card, os blocos opcionais passam a consultar `const show = (k: string) => !cardFields?.length || cardFields.includes(k);` — aplicar em: valor (`show('valor_estimado')`), tags (`show('tags')`), telefone (`show('telefone')`), temperatura (`show('temperatura')`), próximo follow-up (`show('proximo_followup')`). Identidade do card (nome, foto, badge de não lidas, alertas) NUNCA é filtrada.
- No `kanban/page.tsx`, passar `cardFields={view.config.card_fields}` nos dois pontos que renderizam `<LeadCard>` (coluna e drag overlay, l.1074).

- [ ] **Step 3: Verificar** — `cd apps/web && npx tsc --noEmit && npm run build` — Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(dashboard)/kanban/page.tsx" apps/web/src/components/kanban/lead-card.tsx
git commit -m "feat(web): kanban le a view ativa (filtros, sort na coluna e campos do card)"
```

---

### Task 8: Deploy + verificação em produção

**Files:** nenhum novo.

- [ ] **Step 1:** Suíte completa + typecheck final: `cd apps/api && npx jest --maxWorkers=2 && npx tsc --noEmit`; `cd apps/web && npx jest --maxWorkers=2 && npx tsc --noEmit && npm run build`.
- [ ] **Step 2:** Merge na master (se em branch), `git push origin master` — Vercel deploya o front sozinho.
- [ ] **Step 3: Migration no VPS** (Windows `C:\Windows\System32\OpenSSH\ssh.exe`, alias `crm-vps`) — runbook que funcionou na entrega de billing (25/08): escrever `apply-lead-view.js` no scratchpad local com os `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` da Task 2 (um `$executeRawUnsafe` por statement, sem BEGIN/COMMIT — cada um é idempotente), `scp` para `crm-vps:/tmp/`, `ssh crm-vps "docker cp /tmp/apply-lead-view.js crm-backend:/app/ && docker exec crm-backend node /app/apply-lead-view.js && docker exec crm-backend rm /app/apply-lead-view.js"`. (Heredoc via ssh NÃO funciona do PowerShell — mangleia aspas.)
- [ ] **Step 4:** `ssh crm-vps "cd /opt/crm-whatsapp && git pull origin master && docker compose build crm-backend && docker compose up -d crm-backend"` (se o pull travar em arquivo modificado: `git stash push <arquivo>` antes).
- [ ] **Step 5: Verificar:** `curl https://yurilinscrm.duckdns.org/api/health` → 200. No app: abrir `/leads` (tabela carrega com colunas default), criar view com colunas + sort + filtro, salvar, recarregar (view volta), trocar pro kanban (mesma view ativa, cards refletem `card_fields`), mexer num filtro (aparece Salvar/Descartar), OPERADOR não vê opção de compartilhada.
- [ ] **Step 6:** Atualizar memória do projeto (estado da entrega da rodada Twenty item 1).

---

## Self-review (feito na escrita)

- Spec coberto: modelo/migração (T2), sanitização+guard (T3), sort whitelist + select extras (T4), lib de hidratação (T1), ViewBar+estado sujo+localStorage+view deletada (T5), Lista com colunas/células/paginação/drawer (T6), kanban filtros+sort+card_fields sem tocar colunas de etapa (T7), deploy runbook (T8).
- Sem placeholders: os pontos "conferir shape real" (mock do spec existente, props do LeadFilterPanel/drawer, sidebar) são instruções de leitura de arquivo existente com localização dada — não são TBD de design.
- Tipos consistentes: `LeadViewConfig`/`ViewColumn`/`ViewSort` (T1) usados em T5–T7; `SORTABLE_FIELDS` (T3) espelha a whitelist de `buildSortOrder` (T4) — mesma lista de 6 campos; DTO da view em T5 casa com colunas da T2.
- Decisão registrada: sanitização do sort acontece DUAS vezes de propósito (T3 grava limpo; T4 defende a query de qualquer chamador) — barato e cada camada se protege.
