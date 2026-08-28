# Modo Individual Redondo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar o modo individual do CRM: chat cortado por instância, modo foco pessoal do gerente, nuvem de leads devolvidos, aviso na troca de modo e "Ver como membro".

**Architecture:** Toda a visibilidade continua centralizada na função pura `buildVisibilityWhere` (lead-visibility.ts), que ganha `focusMode` e a regra da nuvem; `getMessages` deixa de dar visão total ao dono comum no modo individual. Duas colunas novas (`User.focus_mode`, `Lead.returned_at`), aditivas.

**Tech Stack:** NestJS + Prisma (apps/api), Next.js 14 App Router (apps/web), Jest, Supabase Postgres (banco poluído — ritual de migration manual).

**Spec:** `docs/superpowers/specs/2026-08-28-modo-individual-redondo-design.md`

## Global Constraints

- NUNCA `any` no TypeScript (CLAUDE.md regra 2).
- NUNCA `prisma migrate deploy`/`db push` — SQL manual via DIRECT_URL + transação (CLAUDE.md "Migrations — estado real do banco").
- SEMPRE emitir WebSocket após mutações Kanban/Chat (regra 8) — returnToPool/claim/reassign já emitem; não remover.
- Zod para validar todo input novo (regra 7).
- O banco Supabase é ÚNICO (dev = prod). Colunas novas são aditivas e seguras com backend velho no ar; aplicar antes do deploy do código.
- `roleHierarchy` vem de `apps/api/src/common/guards/roles.guard.ts`; `isManagerRole` de `lead-visibility.ts`.
- Testes: `cd apps/api; npx jest <arquivo>` (rtk hook só quebra `npx prisma`, jest funciona).

---

### Task 1: Schema — colunas `User.focus_mode` e `Lead.returned_at`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model User ~linha 155; model Lead ~linha 408)
- Create: `apps/api/prisma/manual/2026-08-28-modo-individual-redondo.sql`

**Interfaces:**
- Produces: colunas `User.focus_mode Boolean @default(false)` e `Lead.returned_at DateTime?` disponíveis no Prisma Client para todas as tasks seguintes.

- [ ] **Step 1: Editar o schema**

No `model User`, logo após `platform_scopes`:

```prisma
  /// Modo foco: gerente/admin enxerga como operador (só os próprios leads +
  /// sem-dono para distribuir). Só afeta SELECT; permissões de escrita intactas.
  focus_mode        Boolean            @default(false)
```

No `model Lead`, logo após `assumed_at`/`is_private` (~linha 409):

```prisma
  /// Carimbo de devolução ao pool ("nuvem"). Preenchido: qualquer membro vê e
  /// pode assumir no modo individual. Limpo em claim/reassign/atribuição.
  returned_at    DateTime?
```

- [ ] **Step 2: Escrever a SQL manual**

`apps/api/prisma/manual/2026-08-28-modo-individual-redondo.sql`:

```sql
-- Modo individual redondo (spec 2026-08-28). Aditiva, segura com backend
-- velho no ar. Aplicar via DIRECT_URL (pooler transaction-mode dá 25001).
BEGIN;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "focus_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "returned_at" TIMESTAMP(3);
COMMIT;
```

- [ ] **Step 3: Aplicar no banco via DIRECT_URL**

Da raiz do repo (o `.env` de apps/api tem `DIRECT_URL`):

```bash
cd apps/api
node -e "const {Client}=require('pg');require('dotenv').config();const c=new Client({connectionString:process.env.DIRECT_URL});c.connect().then(async()=>{const sql=require('fs').readFileSync('prisma/manual/2026-08-28-modo-individual-redondo.sql','utf8');await c.query(sql);console.log('ok');await c.end();}).catch(e=>{console.error(e);process.exit(1);})"
```

Expected: `ok`. Conferir com `node scripts/introspect-db.mjs` (helper read-only) que as colunas existem.

- [ ] **Step 4: Regenerar o client**

```bash
cd apps/api
node ../../node_modules/prisma/build/index.js generate
```

Expected: generate sem erro; `npx tsc --noEmit` continua limpo.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/manual/2026-08-28-modo-individual-redondo.sql
git commit -m "feat(api): schema — User.focus_mode e Lead.returned_at (modo individual redondo)"
```

---

### Task 2: `buildVisibilityWhere` — modo foco + nuvem (TDD)

**Files:**
- Modify: `apps/api/src/modules/leads/lead-visibility.ts`
- Test: `apps/api/src/modules/leads/lead-visibility.spec.ts`

**Interfaces:**
- Produces: `VisibilityInput` ganha `focusMode?: boolean`. Assinatura final:
  `buildVisibilityWhere({ userId, role, poolEnabled, scope?, focusMode? }): LeadWhere`.
  Task 3 passa `focusMode` vindo de `User.focus_mode`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao `lead-visibility.spec.ts` (seguir o estilo dos describes existentes):

```ts
describe('buildVisibilityWhere — modo foco (gerente vira operador)', () => {
  it('INDIVIDUAL + foco: gerente vê os próprios + qualquer sem-dono não-privado', () => {
    const where = buildVisibilityWhere({
      userId: 'g1', role: UserRole.GERENTE, poolEnabled: false, focusMode: true,
    });
    expect(where).toEqual({
      OR: [
        { responsavel_id: 'g1' },
        { responsavel_id: null, is_private: false },
      ],
    });
  });

  it('COMPARTILHADO + foco: gerente cai na regra de operador (pool + próprios)', () => {
    const where = buildVisibilityWhere({
      userId: 'g1', role: UserRole.SUPER_ADMIN, poolEnabled: true, focusMode: true,
    });
    expect(where).toEqual({
      OR: [
        { responsavel_id: null, is_private: false },
        { responsavel_id: 'g1' },
      ],
    });
  });

  it('foco NÃO muda nada para operador', () => {
    const comFoco = buildVisibilityWhere({
      userId: 'o1', role: UserRole.OPERADOR, poolEnabled: false, focusMode: true,
    });
    const semFoco = buildVisibilityWhere({
      userId: 'o1', role: UserRole.OPERADOR, poolEnabled: false, focusMode: false,
    });
    expect(comFoco).toEqual(semFoco);
  });
});

describe('buildVisibilityWhere — nuvem de devolvidos (INDIVIDUAL)', () => {
  it('operador vê os próprios + devolvidos (returned_at preenchido)', () => {
    const where = buildVisibilityWhere({
      userId: 'o1', role: UserRole.OPERADOR, poolEnabled: false,
    });
    expect(where).toEqual({
      OR: [
        { responsavel_id: 'o1' },
        { responsavel_id: null, returned_at: { not: null }, is_private: false },
      ],
    });
  });

  it('scope=chat continua estrito: só os próprios, para QUALQUER role', () => {
    for (const role of [UserRole.OPERADOR, UserRole.GERENTE, UserRole.SUPER_ADMIN]) {
      const where = buildVisibilityWhere({
        userId: 'u1', role, poolEnabled: false, scope: 'chat', focusMode: true,
      });
      expect(where).toEqual({ responsavel_id: 'u1' });
    }
  });

  it('gerente SEM foco no INDIVIDUAL segue supervisionando tudo', () => {
    const where = buildVisibilityWhere({
      userId: 'g1', role: UserRole.GERENTE, poolEnabled: false,
    });
    expect(where).toEqual({ OR: [{ is_private: false }, { responsavel_id: 'g1' }] });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/api; npx jest lead-visibility.spec
```

Expected: FAIL — casos novos quebram (estrutura antiga usa `where.responsavel_id` no individual).

ATENÇÃO: os describes EXISTENTES do modo individual esperam a forma antiga
(`{ responsavel_id: userId, OR: [...] }`). Eles vão quebrar com a forma nova —
atualizar as expectativas deles para a forma nova equivalente (mesma semântica:
operador vê só os seus; a novidade é o ramo da nuvem). Não deletar casos.

- [ ] **Step 3: Implementar**

Substituir `VisibilityInput` e `buildVisibilityWhere` em `lead-visibility.ts`
(manter `isManagerRole`, `mergeSearchCondition` e o doc-comment do topo,
atualizando-o para citar foco e nuvem):

```ts
export interface VisibilityInput {
  userId: string;
  role: UserRole;
  poolEnabled: boolean;
  /** 'chat' restringe TODO role aos próprios no modo individual. */
  scope?: string;
  /** Gerente+ com modo foco: enxerga como operador, mais os sem-dono p/ distribuir. */
  focusMode?: boolean;
}

export function buildVisibilityWhere(input: VisibilityInput): LeadWhere {
  const { userId, role, poolEnabled, scope, focusMode } = input;
  const where: LeadWhere = {};
  const supervising = isManagerRole(role) && !focusMode;

  if (poolEnabled) {
    if (supervising) {
      where.OR = [{ is_private: false }, { responsavel_id: userId }];
    } else {
      where.OR = [
        { responsavel_id: null, is_private: false },
        { responsavel_id: userId },
      ];
    }
    return where;
  }

  // INDIVIDUAL
  if (scope === 'chat') {
    // Anti-leak Cajuru: no chat todo mundo vê só as próprias conversas —
    // supervisão global (e nuvem) só no Kanban/lista.
    where.responsavel_id = userId;
    return where;
  }
  if (supervising) {
    where.OR = [{ is_private: false }, { responsavel_id: userId }];
    return where;
  }
  if (isManagerRole(role)) {
    // Foco: os próprios + QUALQUER sem-dono (novo ou devolvido) — distribuir
    // continua sendo papel do gerente mesmo atendendo a própria carteira.
    where.OR = [
      { responsavel_id: userId },
      { responsavel_id: null, is_private: false },
    ];
    return where;
  }
  // OPERADOR/VISUALIZADOR: os próprios + nuvem (só DEVOLVIDOS; lead novo sem
  // dono fica invisível — quem distribui é o gerente).
  where.OR = [
    { responsavel_id: userId },
    { responsavel_id: null, returned_at: { not: null }, is_private: false },
  ];
  return where;
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
cd apps/api; npx jest lead-visibility.spec
```

Expected: PASS (novos e antigos ajustados).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/leads/lead-visibility.ts apps/api/src/modules/leads/lead-visibility.spec.ts
git commit -m "feat(api): visibilidade — modo foco do gerente e nuvem de devolvidos"
```

---

### Task 3: `findAll` integra foco, conserta o furo do Ver como e cacheia certo

**Files:**
- Modify: `apps/api/src/modules/leads/leads.service.ts:233-244` (buildLeadsListKey), `:385-435` (findAll), leadListSelect (~:438)

**Interfaces:**
- Consumes: `buildVisibilityWhere` com `focusMode` (Task 2); `pushAnd` de `lead-filters.ts`; coluna `focus_mode` (Task 1).
- Produces: `GET /api/leads?responsavel_id=<uuid>` honrado SÓ para gerente sem foco ("Ver como", Task 10). `leadListSelect` passa a devolver `returned_at` (Task 8 usa no card).

- [ ] **Step 1: Buscar focus_mode junto do tenant em `findAll`**

Trocar o bloco das linhas 388-402 por:

```ts
    // Visibilidade depende do MODO do tenant e do modo foco do usuário:
    const [tenant, me] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { pool_enabled: true },
      }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { focus_mode: true },
      }),
    ]);
    const poolEnabled = Boolean(tenant?.pool_enabled);
    const focusMode = Boolean(me?.focus_mode);
    Object.assign(
      where,
      buildVisibilityWhere({
        userId: user.id,
        role: user.role as UserRole,
        poolEnabled,
        scope: filters.scope,
        focusMode,
      }),
    );
```

- [ ] **Step 2: Consertar o furo do filtro `responsavel_id`**

A linha 406 (`if (filters.responsavel_id) where.responsavel_id = filters.responsavel_id;`)
sobrescreve o recorte de visibilidade — operador podia passar o param e ver
card de colega. Trocar por:

```ts
    // "Ver como membro": só gerente supervisionando pode recortar por outro
    // responsável. Antes disto o param sobrescrevia where.responsavel_id e
    // furava o modo individual.
    if (
      filters.responsavel_id &&
      isManagerRole(user.role as UserRole) &&
      !focusMode
    ) {
      pushAnd(where, { responsavel_id: filters.responsavel_id });
    }
```

(`pushAnd` já é importado de `./lead-filters`; `isManagerRole` importar de
`./lead-visibility` se ainda não estiver.)

- [ ] **Step 3: Cache key inclui o foco**

`buildLeadsListKey` (linha 233): acrescentar parâmetro e incluir no hash —
sem isso o board focado é servido do cache do board completo:

```ts
  private buildLeadsListKey(
    tenantId: string,
    filters: LeadFilters,
    role: string,
    userId: string,
    focusMode: boolean,
  ): string {
    const hash = createHash('sha1')
      .update(JSON.stringify({ filters, role, userId, focusMode }))
      .digest('hex')
      .slice(0, 16);
    return `leads:list:${tenantId}:${hash}`;
  }
```

E na chamada (linha 434): `this.buildLeadsListKey(user.tenantId, filters, user.role, user.id, focusMode)`.

- [ ] **Step 4: `leadListSelect` devolve `returned_at`**

No objeto `leadListSelect` (~linha 438), junto de `position: true`, acrescentar:

```ts
      returned_at: true,
```

- [ ] **Step 5: Compilar e rodar specs do módulo**

```bash
cd apps/api; npx tsc --noEmit; npx jest src/modules/leads
```

Expected: compila; specs de leads passam (ajustar mocks que agora precisam de
`prisma.user.findUnique` devolvendo `{ focus_mode: false }` — os specs de
findAll que mockam tenant.findUnique ganham o mock irmão).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/leads/leads.service.ts apps/api/src/modules/leads/*.spec.ts
git commit -m "feat(api): findAll respeita modo foco e fecha furo do filtro responsavel_id"
```

---

### Task 4: `getMessages` — corte do chat no modo individual (TDD)

**Files:**
- Modify: `apps/api/src/modules/leads/leads.service.ts:1592-1681`
- Test: `apps/api/src/modules/leads/leads-messages-individual.spec.ts` (novo; usar `leads-messages-ad.spec.ts` como referência de mocks)

**Interfaces:**
- Consumes: colunas `focus_mode`/`pool_enabled`.
- Produces: comportamento — no INDIVIDUAL, dono comum vê só as conversas dele; gerente sem foco vê tudo; gerente focado vê como operador, EXCETO lead sem dono (vê tudo para decidir a distribuição).

- [ ] **Step 1: Escrever os testes que falham**

`leads-messages-individual.spec.ts` — mocks no estilo do spec vizinho
(prisma mockado; o que importa é o `where` passado a `message.findMany` e o
retorno vazio do gate). Casos:

```ts
// 1. INDIVIDUAL: dono OPERADOR do lead NÃO recebe scope null — o where de
//    message.findMany deve conter OR por conversation_id/instância própria.
// 2. INDIVIDUAL: GERENTE sem foco recebe scope null (vê tudo).
// 3. INDIVIDUAL: GERENTE com focus_mode=true em lead DE OUTRO responsável →
//    gate devolve { messages: [], nextCursor: undefined }.
// 4. INDIVIDUAL: GERENTE com foco em lead SEM dono → scope null (distribuição
//    precisa ler a conversa).
// 5. COMPARTILHADO: dono continua recebendo scope null (regressão).
```

Cada caso monta `tenant.findFirst → { share_history_enabled: false, pool_enabled: <modo> }`,
`user.findUnique → { focus_mode: <bool> }`, `lead.findFirst → { responsavel_id, ... }`
e afirma sobre o `where` capturado em `message.findMany` (ou o retorno vazio).

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/api; npx jest leads-messages-individual
```

Expected: FAIL (`getMessages` hoje dá null para todo dono e todo gerente).

- [ ] **Step 3: Implementar**

Em `getMessages`:

(a) Trocar a leitura do tenant (linha 1639) para vir ANTES do bloco de acesso e
incluir os dois campos + foco do usuário:

```ts
    const [tenantCfg, me] = await Promise.all([
      this.prisma.tenant.findFirst({
        where: { id: user.tenantId },
        select: { share_history_enabled: true, pool_enabled: true },
      }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { focus_mode: true },
      }),
    ]);
    const poolEnabled = Boolean(tenantCfg?.pool_enabled);
    // Gerente focado abre mão da visão total — MENOS em lead sem dono, onde
    // ler a conversa é o insumo da distribuição.
    const supervising =
      isManager && (!me?.focus_mode || lead.responsavel_id === null);
```

(b) O bloco `if (!isManager) { ... }` (linhas 1619-1634) vira `if (!supervising) { ... }`
— gerente focado passa pelo mesmo gate de acesso do operador.

(c) `hideHistory` (linha 1643) NÃO muda (`!isManager && ...`): o corte de
histórico é privacidade entre operadores; gerente, focado ou não, segue isento.

(d) `conversationScope` (linhas 1652-1660):

```ts
    // Visão total da conversa (todas as instâncias): gerente supervisionando,
    // ou dono no modo COMPARTILHADO. No INDIVIDUAL o dono comum vê só as
    // conversas dele — era o vazamento original do espelhamento.
    const conversationScope: Prisma.MessageWhereInput | null =
      supervising || (isResponsavel && poolEnabled)
        ? null
        : {
            OR: [
              { conversation_id: { in: ownConversationIds } },
              { conversation_id: null, instance_name: { in: ownedInstances } },
            ],
          };
```

- [ ] **Step 4: Rodar e ver passar (novos + regressão)**

```bash
cd apps/api; npx jest leads-messages
```

Expected: PASS nos dois specs (`-ad` e `-individual`).

- [ ] **Step 5: Auditar o escopo paralelo do envio**

`apps/api/src/modules/messages/messages.service.ts:175` monta escopo próprio ao
enviar. Ler o bloco; se ele der visão/efeito total ao `isResponsavel` sem olhar
`pool_enabled`, aplicar a MESMA condição `(isResponsavel && poolEnabled)`.
Se for só validação de acesso de escrita (dono pode mandar mensagem), não mexer
— dono continua podendo responder o próprio lead.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/leads apps/api/src/modules/messages
git commit -m "fix(api): chat do modo individual não espelha mais conversas de outras instancias"
```

---

### Task 5: Nuvem no backend — carimbar e limpar `returned_at` (TDD)

**Files:**
- Modify: `apps/api/src/modules/leads/leads.service.ts` (`claim` :1338-1346, `reassign` :1400-1412, `returnToPool` :1567-1573, `distributeToSector` ~:1440)
- Modify: quem mais ESCREVE `responsavel_id` com dono novo — localizar com `grep -rn "responsavel_id:" apps/api/src/modules --include=*.ts | grep -v spec | grep -v null` (esperados: `webhooks/inbound-message.service.ts` no round-robin/auto-dono, `queue/assignment.service.ts` se escrever no lead)
- Test: `apps/api/src/modules/leads/lead-returned-at.spec.ts` (novo)

**Interfaces:**
- Consumes: coluna `returned_at` (Task 1).
- Produces: invariante — `returned_at != null` ⇔ lead está na nuvem; QUALQUER atribuição de dono zera.

- [ ] **Step 1: Testes que falham**

`lead-returned-at.spec.ts`, com mocks de prisma no estilo de
`lead-conversation-transfer.spec.ts` (que já testa essas mesmas funções):

```ts
// 1. returnToPool: data do lead.update contém returned_at instanceof Date
//    (junto de responsavel_id: null, assumed_at: null, is_private: false).
// 2. claim: data do lead.updateMany contém returned_at: null.
// 3. reassign: data do lead.update contém returned_at: null.
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/api; npx jest lead-returned-at
```

Expected: FAIL (campo ausente nos data).

- [ ] **Step 3: Implementar**

- `returnToPool` (linha 1572): `data: { responsavel_id: null, assumed_at: null, is_private: false, returned_at: new Date() }`.
- `claim` (linha 1341-1345): acrescentar `returned_at: null` ao `data`.
- `reassign` (linha 1403-1410): acrescentar `returned_at: null` ao `data`.
- `distributeToSector` e cada escrita achada no grep do cabeçalho que ATRIBUI
  dono (`responsavel_id: <id>`): acrescentar `returned_at: null`. Escritas que
  DEVOLVEM (`responsavel_id: null` no webhook de "setor sem agente") ganham
  `returned_at: new Date()` — devolução automática também é nuvem.

- [ ] **Step 4: Rodar tudo do módulo**

```bash
cd apps/api; npx jest src/modules/leads src/modules/webhooks src/modules/queue
```

Expected: PASS (specs existentes de claim/reassign/transfer não afirmam
igualdade estrita do `data`; se algum usar `toEqual`, incluir o campo novo).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): nuvem de devolvidos — returned_at carimbado na devolucao e limpo na atribuicao"
```

---

### Task 6: Perfil — `focus_mode` no PATCH /users/me e no /auth/me

**Files:**
- Modify: `apps/api/src/modules/users/users.controller.ts:22-26` (updateProfileSchema), `apps/api/src/modules/users/users.service.ts:138-148` (updateProfile)
- Modify: `apps/api/src/modules/auth/auth.service.ts:290` (getMe select)
- Modify: `apps/web/src/stores/auth.store.ts:4-14` (User type)

**Interfaces:**
- Consumes: coluna `focus_mode` (Task 1).
- Produces: `PATCH /api/users/me { focus_mode: boolean }` persiste; `GET /api/auth/me` devolve `user.focus_mode: boolean`; tipo `User` do auth.store tem `focus_mode?: boolean`. Task 7 consome os três.

- [ ] **Step 1: Backend**

`users.controller.ts` — no `updateProfileSchema`:

```ts
  focus_mode: z.boolean().optional(),
```

`users.service.ts` — `updateProfile`: tipo do dto ganha `focus_mode?: boolean`;
no corpo: `if (dto.focus_mode !== undefined) data.focus_mode = dto.focus_mode;`
e `focus_mode: true` no `select` do retorno.

`auth.service.ts:290` — acrescentar `focus_mode: true` ao select do user em `getMe`.

- [ ] **Step 2: Frontend type**

`auth.store.ts` — na interface `User`:

```ts
  /** Modo foco (gerente+): enxerga o board como operador. */
  focus_mode?: boolean;
```

- [ ] **Step 3: Verificar**

```bash
cd apps/api; npx tsc --noEmit; npx jest src/modules/users src/modules/auth
cd ../../apps/web; npx tsc --noEmit
```

Expected: tudo limpo.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/users apps/api/src/modules/auth apps/web/src/stores/auth.store.ts
git commit -m "feat: focus_mode persiste no perfil e hidrata no /auth/me"
```

---

### Task 7: UI — toggle "Modo foco" no menu do avatar

**Files:**
- Modify: `apps/web/src/components/layout/user-menu.tsx`

**Interfaces:**
- Consumes: `PATCH /api/users/me { focus_mode }` (Task 6); `useAuthStore` (`user.role`, `user.focus_mode`, `updateUser`).
- Produces: item de menu visível só para GERENTE/SUPER_ADMIN que alterna o modo e recarrega a página (o kanban busca no mount; reload garante board coerente).

- [ ] **Step 1: Implementar**

Em `user-menu.tsx` (imports: `Crosshair` do lucide-react; `api` — copiar o
caminho de import usado no `GeneralTab.tsx`; `toast` — mesmo padrão do GeneralTab):

```tsx
  const isManager = role === 'GERENTE' || role === 'SUPER_ADMIN';
  const focusMode = user?.focus_mode ?? false;

  const toggleFocusMode = async () => {
    try {
      await api.patch('/api/users/me', { focus_mode: !focusMode });
      useAuthStore.getState().updateUser({ focus_mode: !focusMode });
      toast.success(
        !focusMode
          ? 'Modo foco ligado: você vê seus leads e os sem dono.'
          : 'Modo foco desligado: visão completa de volta.',
      );
      window.location.reload();
    } catch {
      toast.error('Não deu para salvar o modo foco.');
    }
  };
```

E no `DropdownMenuContent`, entre o item "Perfil" e o separador do "Sair":

```tsx
        {isManager && (
          <DropdownMenuItem onClick={toggleFocusMode}>
            <Crosshair className="mr-2 h-4 w-4" />
            {focusMode ? 'Sair do modo foco' : 'Entrar em modo foco'}
          </DropdownMenuItem>
        )}
```

- [ ] **Step 2: Verificar**

```bash
cd apps/web; npx tsc --noEmit; npm run lint --silent 2>&1 | tail -5
```

Expected: limpo. Conferência manual fica para a Task 11.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/layout/user-menu.tsx
git commit -m "feat(web): toggle de modo foco no menu do avatar (gerente+)"
```

---

### Task 8: UI — selo "Disponível" e Assumir na nuvem

**Files:**
- Modify: componente do card do kanban — localizar com `grep -rn "responsavel" apps/web/src/components/kanban --include=*.tsx -l` (o card mostra avatar do responsável); e o tipo `Lead` do frontend — `grep -rn "returned_at\|interface Lead" apps/web/src -l`
- Modify: onde o botão "Assumir" aparece — `grep -rn "Assumir" apps/web/src -l`

**Interfaces:**
- Consumes: `returned_at` no payload da listagem (Task 3, leadListSelect) e endpoint `POST /api/leads/:id/claim` já existente.
- Produces: card sem responsável com `returned_at` mostra selo "Disponível"; o fluxo de Assumir (hoje condicionado ao modo pool) também aparece para esses cards no modo individual.

- [ ] **Step 1: Tipo**

No tipo `Lead` do frontend (achado no grep), acrescentar:

```ts
  returned_at?: string | null;
```

- [ ] **Step 2: Selo no card**

No componente do card, junto de onde renderiza o avatar/nome do responsável:

```tsx
        {!lead.responsavel && lead.returned_at && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            Disponível
          </span>
        )}
```

(Ajustar classes ao padrão de badges que o card já usa — copiar de um badge
vizinho se existir.)

- [ ] **Step 3: Assumir na nuvem**

Achar a condição que mostra o botão/ação "Assumir" (hoje tipo
`isPoolEnabled && !lead.responsavel`). Estender para a nuvem:

```ts
  const podeAssumir = !lead.responsavel && (isPoolEnabled || Boolean(lead.returned_at));
```

O clique usa o claim que já existe — não criar chamada nova.

- [ ] **Step 4: Verificar e commitar**

```bash
cd apps/web; npx tsc --noEmit
git add apps/web/src
git commit -m "feat(web): selo Disponivel e Assumir para leads da nuvem no modo individual"
```

---

### Task 9: UI — aviso ao trocar o modo de atendimento

**Files:**
- Modify: `apps/web/src/app/(dashboard)/settings/components/GeneralTab.tsx` (Switch :224-229 e handlePoolToggle)

**Interfaces:**
- Consumes: `Dialog` de `@/components/ui/dialog` (existe); `handlePoolToggle` existente (não mudar a chamada à API).

- [ ] **Step 1: Implementar**

Estado novo no componente:

```tsx
  const [pendingMode, setPendingMode] = useState<boolean | null>(null);
```

O Switch deixa de chamar direto:

```tsx
          <Switch
            checked={tenant.pool_enabled}
            onCheckedChange={(checked) => setPendingMode(checked)}
            disabled={isPending}
            aria-label="Modelo de atendimento"
          />
```

Dialog de confirmação (imports de `@/components/ui/dialog` no padrão do projeto):

```tsx
      <Dialog open={pendingMode !== null} onOpenChange={(open) => { if (!open) setPendingMode(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingMode ? 'Mudar para Atendimento Compartilhado?' : 'Mudar para Atendimento Individual?'}
            </DialogTitle>
            <DialogDescription>
              {pendingMode
                ? 'Todos os membros passarão a ver todos os cards e conversas do workspace. Leads sem dono ficam no pool, visíveis para qualquer um assumir.'
                : 'Cada membro passará a ver apenas os próprios cards e apenas as conversas das suas instâncias. Leads sem dono ficam visíveis só para admin/gerente distribuir; leads devolvidos vão para a nuvem, onde qualquer um pode assumir.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingMode(null)}>Cancelar</Button>
            <Button
              onClick={() => {
                const alvo = pendingMode;
                setPendingMode(null);
                if (alvo !== null) void handlePoolToggle(alvo);
              }}
            >
              Confirmar mudança
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

(Se `DialogFooter` não existir no dialog.tsx do projeto, usar um `div` com
`flex justify-end gap-2`.)

- [ ] **Step 2: Verificar e commitar**

```bash
cd apps/web; npx tsc --noEmit
git add "apps/web/src/app/(dashboard)/settings/components/GeneralTab.tsx"
git commit -m "feat(web): confirmacao com aviso ao trocar o modelo de atendimento"
```

---

### Task 10: UI — "Ver como membro" no kanban (gerente)

**Files:**
- Modify: `apps/web/src/app/(dashboard)/kanban/page.tsx` (montagem dos query params ~:338; header onde ficam as abas Meus/Escritório — localizar com `grep -n "Meus" apps/web/src/app/\(dashboard\)/kanban/page.tsx apps/web/src/components/kanban/*.tsx`)

**Interfaces:**
- Consumes: `GET /api/users/list` (lista membros do tenant, endpoint existente); backend já honra `responsavel_id` para gerente sem foco (Task 3).
- Produces: select "Ver como" que injeta `responsavel_id=<uuid>` na query da listagem.

- [ ] **Step 1: Implementar**

Estado + fetch de membros (padrão de fetch do próprio arquivo — seguir como a
página busca `/api/leads`):

```tsx
  const [viewAsUserId, setViewAsUserId] = useState<string>('');
  const isManager = user?.role === 'GERENTE' || user?.role === 'SUPER_ADMIN';
  const showViewAs = isManager && !(user?.focus_mode ?? false);
  // members: buscar de /api/users/list uma vez no mount quando showViewAs.
```

No monte dos params da listagem (junto de pipeline_id etc.):

```ts
  if (viewAsUserId) params.set('responsavel_id', viewAsUserId);
```

No header do board, ao lado das abas Meus/Escritório:

```tsx
        {showViewAs && (
          <select
            value={viewAsUserId}
            onChange={(e) => setViewAsUserId(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
            aria-label="Ver como membro"
          >
            <option value="">Ver como: todos</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.nome}</option>
            ))}
          </select>
        )}
```

(Se o projeto tiver um `Select` de ui/ usado no filtro do painel, usar o mesmo
componente em vez do select nativo. Trocar o valor deve refazer o fetch da
listagem — mesma dependência de efeito dos outros filtros.)

- [ ] **Step 2: Verificar e commitar**

```bash
cd apps/web; npx tsc --noEmit
git add "apps/web/src/app/(dashboard)/kanban/page.tsx" apps/web/src/components/kanban
git commit -m "feat(web): seletor Ver como membro no kanban para gerente"
```

---

### Task 11: Verificação de ponta a ponta + deploy

**Files:**
- Nenhum novo (correções que surgirem).

- [ ] **Step 1: Suíte completa + build**

```bash
cd apps/api; npx jest; npx tsc --noEmit
cd ../../apps/web; npx tsc --noEmit; npm run build
```

Expected: tudo verde. Build do web sem erro.

- [ ] **Step 2: Deploy**

Migração já aplicada (Task 1, banco único). Backend (deploy manual — secret do
workflow ainda não existe): push do master e, no VPS (ssh.exe do Windows, chave
`id_ed25519_crm`):

```bash
git push origin master
ssh -i ~/.ssh/id_ed25519_crm <user>@187.127.11.117 "cd <dir-do-compose> && git pull && docker compose build crm-backend && docker compose up -d crm-backend"
```

Frontend: Vercel builda sozinho no push.

- [ ] **Step 3: Smoke em produção**

1. Login gerente → menu avatar → "Entrar em modo foco" → board mostra só os
   dele + sem-dono; sair do foco → board completo.
2. Tenant individual: operador devolve lead → outro operador vê selo
   "Disponível" e consegue Assumir.
3. Chat: operador dono de lead com conversa em 2 instâncias vê SÓ a dele;
   gerente vê as duas.
4. Ajustes → trocar modelo de atendimento → dialog de aviso aparece; Cancelar
   não muda nada.
5. Kanban gerente → "Ver como: [membro]" recorta o board.
6. Tela de cadastro (signup): a escolha do modelo de atendimento
   (`account_model`) segue exposta — só conferir, já existia.

- [ ] **Step 4: Commit final (ajustes do smoke) e memória**

Registrar o estado no memory (`crm-*`) e atualizar a pendência do espelhamento
como resolvida.
