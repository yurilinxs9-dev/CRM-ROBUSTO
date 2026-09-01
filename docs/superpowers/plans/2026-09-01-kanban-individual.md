# Kanban Individual por Membro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toggle por tenant que dá a cada membro um kanban 100% próprio (colunas independentes), com migração one-shot da Cajuru Interiores (board da Isamara preservado, demais membros voltam ao pré-27/08).

**Architecture:** `Stage.user_id` nullable separa modelo base (null) de coluna pessoal. Serviço novo `KanbanIndividualService` (módulo próprio, só depende de Prisma) concentra enable/disable/clone/remap; `PipelinesService` ganha scoping de leitura/escrita; `LeadsService` e inbound remapeiam etapa na troca de dono. Spec: `docs/superpowers/specs/2026-09-01-kanban-individual-design.md`.

**Tech Stack:** NestJS + Prisma + Zod (api), Next.js 14 + react-query (web), jest com prisma mockado na mão (padrão `pipelines.service.spec.ts`).

## Global Constraints

- NUNCA `prisma migrate deploy` nem `db push` — fluxo do CLAUDE.md: `migrate diff` → revisar SQL → aplicar via `DIRECT_URL` em transação → `migrate resolve --applied`.
- `npx prisma` quebra pelo rtk hook → `node ../../node_modules/prisma/build/index.js ...` (de `apps/api`).
- NUNCA `any` no TypeScript. Input de rota sempre Zod.
- SEMPRE emitir WebSocket após mutação de Kanban (gateway já existente; enable/disable e remaps de lead emitem).
- Testes: de `apps/api`, `npx jest <nome-do-spec>`. Commits frequentes, mensagens em pt-BR estilo do repo (`feat(api): ...`).
- Tenant Cajuru: `bb4953ac-b37f-4445-81c0-f54508c77141`; Isamara: `dc416756-a583-447b-9e62-cc63e132bf00`; corte das colunas dela: `created_at >= '2026-08-27'`.

---

### Task 1: Schema — `Tenant.kanban_individual` + `Stage.user_id`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (models `Tenant`, `Stage`, `User`)
- Create: `apps/api/prisma/migrations/20260901120000_kanban_individual/migration.sql`

**Interfaces:**
- Produces: coluna `Tenant.kanban_individual Boolean @default(false)`; `Stage.user_id String?` com relação `owner User?` (`onDelete: SetNull`) e `@@index([tenant_id, user_id])`; lado inverso `User.stages_pessoais Stage[]`.

- [ ] **Step 1: Editar o schema**

Em `model Tenant`, junto dos flags (`pool_enabled` etc.):

```prisma
  /// Kanban individual: cada membro tem conjunto próprio de colunas
  /// (Stage.user_id). Spec docs/superpowers/specs/2026-09-01-kanban-individual-design.md.
  kanban_individual Boolean @default(false)
```

Em `model Stage` (depois de `tenant`):

```prisma
  /// null = coluna do modelo base do tenant (template); preenchido = coluna
  /// pessoal do membro (só aparece no board dele quando kanban_individual).
  user_id String?
  owner   User?   @relation("StagesPessoais", fields: [user_id], references: [id], onDelete: SetNull)
```

E no bloco de índices do Stage: `@@index([tenant_id, user_id])`.

Em `model User`: `stages_pessoais Stage[] @relation("StagesPessoais")`.

- [ ] **Step 2: Gerar SQL de diff**

```bash
cd apps/api
node ../../node_modules/prisma/build/index.js migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260901120000_kanban_individual/migration.sql
```

Revisar o arquivo: manter SÓ `ALTER TABLE "Tenant" ADD COLUMN "kanban_individual" BOOLEAN NOT NULL DEFAULT false;`, `ALTER TABLE "Stage" ADD COLUMN "user_id" TEXT;`, o `ADD CONSTRAINT ... FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL`, e o `CREATE INDEX "Stage_tenant_id_user_id_idx"`. Apagar qualquer linha de drift não relacionado (FKs de Lead/InstanceHidden/PushSubscription, tipo de `Lead.assumed_at`).

- [ ] **Step 3: Aplicar e registrar**

Aplicar o SQL inteiro numa transação via `DIRECT_URL` (script node one-off com `prisma.$executeRawUnsafe` por statement dentro de `$transaction`, ou psql se disponível). Depois:

```bash
node ../../node_modules/prisma/build/index.js migrate resolve --applied 20260901120000_kanban_individual
node ../../node_modules/prisma/build/index.js generate
```

- [ ] **Step 4: Verificar**

Rodar `node scripts/introspect-db.mjs` (deve seguir sem unfinished novas) e um one-off `SELECT kanban_individual FROM "Tenant" LIMIT 1` + `SELECT user_id FROM "Stage" LIMIT 1` sem erro.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260901120000_kanban_individual
git commit -m "feat(api): schema do kanban individual — Tenant.kanban_individual e Stage.user_id"
```

---

### Task 2: `KanbanIndividualService` — enable/disable/clone/remap

**Files:**
- Create: `apps/api/src/modules/pipelines/kanban-individual.service.ts`
- Create: `apps/api/src/modules/pipelines/kanban-individual.module.ts`
- Test: `apps/api/src/modules/pipelines/kanban-individual.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, tipos `AuthUser`, `UserRole`.
- Produces (usado pelas Tasks 3–6):
  - `isOn(tenantId: string): Promise<boolean>`
  - `enable(user: AuthUser): Promise<{ success: true }>` — clona base p/ membros, remapeia leads, liga flag. Lança `ConflictException` se já ligado.
  - `disable(user: AuthUser): Promise<{ success: true }>` — remapeia leads p/ base por nome (fallback primeira base), anula `Broadcast.stage_id` que aponte p/ coluna pessoal, apaga colunas pessoais, desliga flag.
  - `stageForOwner(tenantId: string, ownerId: string, fromStageId: string): Promise<string>` — id da coluna do dono com mesmo nome (case-insensitive, mesmo pipeline); fallback primeira coluna (menor `ordem`) do dono; se toggle OFF devolve `fromStageId`.
  - `stageForBase(tenantId: string, fromStageId: string): Promise<string>` — idem, mirando o conjunto base.
  - `cloneBaseForUser(tx: Prisma.TransactionClient, tenantId: string, userId: string, pipelineId?: string): Promise<void>` — clona colunas base (todos os campos de config) com `user_id = userId`.
  - `KanbanIndividualModule` exporta o service; não importa nenhum módulo além do de Prisma (zero risco de ciclo).

- [ ] **Step 1: Escrever specs que falham** (`kanban-individual.service.spec.ts`, prisma mockado na mão como em `pipelines.service.spec.ts`)

Casos mínimos:

```ts
// enable: clona base para cada membro ativo (role >= OPERADOR) e remapeia
it('enable clona colunas base para cada membro e remapeia leads do responsavel', async () => {
  // prisma mock: tenant {kanban_individual:false}, users [op1, ger1],
  // stages base [{id:'b1',nome:'Novo',ordem:0},{id:'b2',nome:'Ganho',ordem:1,is_won:true}]
  // $transaction executa callback com o próprio mock
  await service.enable(gerente);
  // espera: stage.createMany/create com user_id op1 e ger1 (2x2 colunas)
  // espera: lead.updateMany por (responsavel_id, estagio_id b1→clone-op1-b1) etc.
  // espera: tenant.update({ kanban_individual: true })
});

it('enable com toggle ja ligado lança ConflictException', async () => { /* tenant.kanban_individual=true */ });

it('disable remapeia por nome para a base, anula Broadcast.stage_id e apaga pessoais', async () => {
  // pessoais [{id:'p1',nome:'Novo',user_id:'op1'},{id:'p9',nome:'Leds',user_id:'op1'}]
  // base [{id:'b1',nome:'Novo',ordem:0}]
  // espera: leads de p1→b1 (nome igual), p9→b1 (fallback primeira base)
  // espera: broadcast.updateMany({ where:{stage_id:{in:['p1','p9']}}, data:{stage_id:null} })
  // espera: stage.deleteMany({ where:{tenant_id, user_id:{not:null}} })
});

it('stageForOwner devolve coluna de mesmo nome do dono, fallback primeira', async () => { /* dois cenários */ });
it('stageForOwner com toggle OFF devolve o proprio fromStageId', async () => {});
```

Escrever os asserts contra as chamadas do mock (`expect(prisma.stage.create).toHaveBeenCalledWith(...)`), não contra internals.

- [ ] **Step 2: Rodar e ver falhar**

`npx jest kanban-individual` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar o service**

Pontos obrigatórios da implementação:

```ts
@Injectable()
export class KanbanIndividualService {
  constructor(private prisma: PrismaService) {}

  async isOn(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId }, select: { kanban_individual: true },
    });
    return t?.kanban_individual === true;
  }

  async cloneBaseForUser(tx: Prisma.TransactionClient, tenantId: string, userId: string, pipelineId?: string) {
    const base = await tx.stage.findMany({
      where: { tenant_id: tenantId, user_id: null, ...(pipelineId ? { pipeline_id: pipelineId } : {}) },
      orderBy: { ordem: 'asc' },
    });
    for (const s of base) {
      await tx.stage.create({
        data: {
          nome: s.nome, cor: s.cor, ordem: s.ordem, pipeline_id: s.pipeline_id,
          tenant_id: tenantId, user_id: userId,
          is_won: s.is_won, is_lost: s.is_lost, max_dias: s.max_dias,
          probabilidade: s.probabilidade,
          auto_action: (s.auto_action ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          campos_obrigatorios: (s.campos_obrigatorios ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sla_config: (s.sla_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          idle_alert_config: (s.idle_alert_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          response_alert_config: (s.response_alert_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          on_entry_config: (s.on_entry_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          cadence_config: (s.cadence_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    }
  }
  // enable(): $transaction → membros ativos (user.findMany {tenant_id, ativo:true,
  //   role in [OPERADOR, GERENTE, SUPER_ADMIN]}) → cloneBaseForUser por membro →
  //   para cada membro M e cada base B: lead.updateMany({where:{tenant_id,
  //   responsavel_id:M, estagio_id:B.id}, data:{estagio_id: cloneDeMparaB}}) →
  //   tenant.update kanban_individual:true. Leads sem responsavel ficam na base.
  // disable(): $transaction inversa, matching por nome via toLowerCase().trim().
  // stageForOwner/stageForBase: findFirst por nome (mode:'insensitive') no
  //   mesmo pipeline do fromStage; fallback findFirst orderBy ordem asc.
}
```

`enable`/`disable` recebem `AuthUser` e validam `role` GERENTE/SUPER_ADMIN (`ForbiddenException`). Módulo:

```ts
@Module({ providers: [KanbanIndividualService], exports: [KanbanIndividualService] })
export class KanbanIndividualModule {}
```

(Se `PrismaService` vier de módulo global do repo, nada a importar; senão importar o módulo de Prisma usado pelos outros.)

- [ ] **Step 4: Rodar testes** — `npx jest kanban-individual` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pipelines/kanban-individual.*
git commit -m "feat(api): KanbanIndividualService — clone, remap e toggle do kanban por membro"
```

---

### Task 3: Endpoint do toggle + flag na sessão

**Files:**
- Create: `apps/api/src/modules/pipelines/kanban-individual.controller.ts`
- Modify: `apps/api/src/modules/pipelines/pipelines.module.ts` (importar `KanbanIndividualModule`, registrar controller)
- Modify: `apps/api/src/modules/auth/auth.service.ts:295` (select do tenant: adicionar `kanban_individual: true`)
- Test: ampliar `kanban-individual.service.spec.ts` (roles) — controller é fino, sem spec próprio.

**Interfaces:**
- Produces: `POST /api/kanban-individual` body `{ enabled: boolean }`, `@Roles(UserRole.GERENTE)`, chama `enable`/`disable`; devolve `{ success: true, kanban_individual: boolean }`. Sessão (`/me`) passa a incluir `tenant.kanban_individual`.

- [ ] **Step 1: Teste de role no service** (se ainda não coberto): `enable` com OPERADOR → `ForbiddenException`. Rodar → FAIL.
- [ ] **Step 2: Controller**

```ts
const toggleSchema = z.object({ enabled: z.boolean() });

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('kanban-individual')
export class KanbanIndividualController {
  constructor(private readonly svc: KanbanIndividualService) {}

  @Post()
  @Roles(UserRole.GERENTE)
  async toggle(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    const { enabled } = toggleSchema.parse(body);
    const user = req.user as AuthUser;
    if (enabled) await this.svc.enable(user); else await this.svc.disable(user);
    return { success: true, kanban_individual: enabled };
  }
}
```

Copiar imports/guards do `tenants.controller.ts` (mesmo padrão). Registrar no `pipelines.module.ts`.

- [ ] **Step 3: Sessão** — em `auth.service.ts` linha ~295, adicionar `kanban_individual: true` ao select do tenant.
- [ ] **Step 4: Rodar** — `npx jest kanban-individual` PASS; `npm run build` sem erro.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): endpoint de toggle do kanban individual + flag na sessao"`.

---

### Task 4: Scoping de LEITURA das etapas (`findAll`/`findOne` + `view_as_user_id`/`stage_scope`)

**Files:**
- Modify: `apps/api/src/modules/pipelines/pipelines.service.ts:86-113` (`findAll`, `findOne`)
- Modify: `apps/api/src/modules/pipelines/pipelines.controller.ts:26-30` (query params)
- Test: `apps/api/src/modules/pipelines/pipelines.service.spec.ts` (describe novo)

**Interfaces:**
- Consumes: `KanbanIndividualService.isOn` (injetar no `PipelinesService`; `pipelines.module` importa `KanbanIndividualModule`).
- Produces: `findAll(user, includeArchived?, opts?: { viewAsUserId?: string; stageScope?: 'own' | 'base' })` e `findOne(id, user, opts?)`. Controller aceita `?view_as_user_id=` e `?stage_scope=base`.

- [ ] **Step 1: Testes que falham** (mock de `KanbanIndividualService` como `{ isOn: jest.fn() }`):

```ts
// toggle OFF: stages sem filtro extra além de user_id null
// toggle ON: where das stages ganha { user_id: user.id }
// toggle ON + view_as_user_id por GERENTE: { user_id: viewAs }
// toggle ON + view_as_user_id por OPERADOR: ForbiddenException
// toggle ON + stage_scope 'base' por GERENTE: { user_id: null }
// toggle ON + stage_scope 'base' por OPERADOR: ForbiddenException
```

Assert no argumento de `prisma.pipeline.findMany` (`include.stages.where`). Rodar → FAIL.

- [ ] **Step 2: Implementar**

No service, helper privado:

```ts
private async stageScopeWhere(
  user: AuthUser,
  opts?: { viewAsUserId?: string; stageScope?: 'own' | 'base' },
): Promise<Prisma.StageWhereInput> {
  const on = await this.kanbanIndividual.isOn(user.tenantId);
  if (!on) return { user_id: null };
  const ehGestor = user.role === 'GERENTE' || user.role === 'SUPER_ADMIN';
  if (opts?.stageScope === 'base') {
    if (!ehGestor) throw new ForbiddenException('Apenas gestores editam o modelo base.');
    return { user_id: null };
  }
  if (opts?.viewAsUserId && opts.viewAsUserId !== user.id) {
    if (!ehGestor) throw new ForbiddenException('Apenas gestores usam Ver como.');
    return { user_id: opts.viewAsUserId };
  }
  return { user_id: user.id };
}
```

`findAll`/`findOne`: `stages: { where: await this.stageScopeWhere(user, opts), orderBy: { ordem: 'asc' } }`. Controller repassa `view_as_user_id`/`stage_scope` da query (validar `stage_scope` com `z.enum(['own','base']).optional()`).

- [ ] **Step 3: Rodar** — `npx jest pipelines.service` PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): leitura de etapas com escopo por membro (view_as, stage_scope)"`.

---

### Task 5: Scoping de ESCRITA das etapas (create/update/reorder/delete) + clone em pipeline novo

**Files:**
- Modify: `apps/api/src/modules/pipelines/pipelines.service.ts` (`createStage:294`, `updateStage:316`, `removeStage:347`, `removeStageWithMove:364`, `reorderStages:393`, `create:115`, `duplicate:166`)
- Modify: `apps/api/src/modules/pipelines/pipelines.controller.ts` (createStage/reorder aceitam scope via body)
- Test: `pipelines.service.spec.ts`

**Interfaces:**
- Consumes: `KanbanIndividualService.isOn` e `cloneBaseForUser`.
- Produces: `createStageSchema` ganha `scope: z.enum(['own','base']).optional()` (default `own`); reorder valida contra o conjunto do escopo do chamador.

Regras (toggle ON):
- `createStage`: `scope:'own'` → cria com `user_id: user.id`; `scope:'base'` → só gestor, `user_id: null`. `ordem` calculada dentro do escopo (`where` do `findFirst` de última etapa ganha o filtro de `user_id`).
- `updateStage`/`removeStage`/`removeStageWithMove`: carregar a stage; se `user_id === null` → só gestor; se `user_id !== user.id` → `ForbiddenException('Coluna de outro membro')` (nem gestor edita coluna alheia). Guarda fina `CAMPOS_STAGE_OPERADOR` continua como está. `removeStageWithMove`: target precisa do MESMO `user_id` da origem.
- `reorderStages`: buscar stages do pipeline no escopo do chamador (`user_id: user.id`, ou `null` p/ gestor se todos os ids forem base) e validar `stageIds` contra esse conjunto.
- `create` (pipeline novo) e `duplicate`: após criar as stages base, se toggle ON → `cloneBaseForUser` para cada membro ativo, dentro da mesma transação (converter os métodos p/ `$transaction(async (tx) => ...)` onde ainda não são).
- Toggle OFF: comportamento idêntico ao atual (todos os caminhos com `user_id: null` implícito).

- [ ] **Step 1: Testes que falham** — casos: operador cria coluna própria (`user_id` = ele); operador com `scope:'base'` → 403; operador edita coluna do colega → 403; gestor edita base → ok; gestor edita coluna de membro → 403; `removeStageWithMove` cruzando escopos → 400; reorder com id de outro escopo → 400. Rodar → FAIL.
- [ ] **Step 2: Implementar** conforme regras acima (helper privado `assertStageEditavel(stage, user)` para não repetir o if em 3 métodos).
- [ ] **Step 3: Rodar** — `npx jest pipelines` PASS (incluindo specs antigos: nada de regressão com toggle OFF).
- [ ] **Step 4: Commit** — `git commit -m "feat(api): escrita de etapas escopada por dono no kanban individual"`.

---

### Task 6: Remap de lead na troca de dono + board query + nuvem

**Files:**
- Modify: `apps/api/src/modules/leads/leads.service.ts` (`claim:1397`, `reassign:1463`, `returnToPool:1662`, board `per_stage:602-639`)
- Modify: `apps/api/src/modules/leads/leads.module.ts` (+ webhooks module) — importar `KanbanIndividualModule`
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts:555-597` (auto-assign e round-robin) e `:280-288` (firstStage do inbound: `where` ganha `user_id: null`)
- Test: `apps/api/src/modules/leads/lead-kanban-individual.spec.ts` (novo)

**Interfaces:**
- Consumes: `stageForOwner`, `stageForBase`, `isOn`.
- Produces: comportamento — ver regras.

Regras (todas no-op com toggle OFF, porque `stageForOwner` devolve o próprio id):
1. `claim`: dentro da transação, após o `updateMany` que dá posse, `const novoEstagio = await this.kanbanIndividual.stageForOwner(user.tenantId, user.id, lead.estagio_id)` e, se mudou, `tx.lead.update({ data: { estagio_id: novoEstagio, estagio_entered_at: new Date() } })`. (Carregar `estagio_id` do lead antes; o método hoje não seleciona.)
2. `reassign`: idem, mirando `novoResponsavelId`.
3. `returnToPool`: remapear para `stageForBase(...)` no mesmo update que carimba `returned_at`.
4. Auto-assign do inbound (`inbound-message.service.ts:558-568` e `:574-597`): após dar dono, remapear com `stageForOwner` (o service já emite `emitLeadUpdated`; incluir `estagio_id` no payload emitido quando mudar).
5. `firstStage` do inbound (`:280-283`): adicionar `user_id: null` ao where — lead novo sem dono nasce na primeira coluna BASE.
6. Board `per_stage` (`leads.service.ts:606-609`): o `findMany` de stages ganha escopo: toggle ON → `user_id: (gestor && filters.responsavel_id) ? filters.responsavel_id : user.id`; OFF → `user_id: null`.
7. Nuvem na primeira coluna: no loop `runQuery` (linha 611), para a stage de menor `ordem` do conjunto, o where vira `{ OR: [{ estagio_id: s.id }, { responsavel_id: null, returned_at: { not: null } }] }` (toggle ON). E no pós-processamento de `stage_counts` (linhas 628-633), contagens de `estagio_id` fora do conjunto do viewer somam na primeira coluna.

- [ ] **Step 1: Testes que falham** (`lead-kanban-individual.spec.ts`, padrão dos specs vizinhos `lead-returned-at.spec.ts`):

```ts
// claim remapeia estagio para coluna de mesmo nome do claimer
// claim com toggle OFF nao toca estagio_id
// reassign remapeia para coluna do novo responsavel (fallback primeira)
// returnToPool manda para base de mesmo nome
```

Rodar → FAIL.
- [ ] **Step 2: Implementar** itens 1–5. Rodar spec novo + `npx jest lead-returned-at lead-conversation-transfer` (regressão) → PASS.
- [ ] **Step 3: Implementar** itens 6–7 (board query). Teste: ampliar spec novo com caso `per_stage` usando prisma mockado (asserts no `where` do `stage.findMany` e no OR da primeira coluna). Rodar → PASS.
- [ ] **Step 4: Rodar suite inteira da api** — `npx jest` → PASS. `npm run build` limpo.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): remap de etapa na troca de dono e board escopado no kanban individual"`.

---

### Task 7: Frontend — switch em Ajustes + kanban com view_as + tela de etapas no modelo base

**Files:**
- Modify: `apps/web/src/app/(dashboard)/settings/components/GeneralTab.tsx`
- Modify: `apps/web/src/app/(dashboard)/kanban/page.tsx` (query `['pipelines']:180-186`, seletor Ver como `:1063`, `viewAsApplied:303`)
- Modify: `apps/web/src/app/(dashboard)/settings/pipeline/page.tsx` (GET `:107` e banner)

**Interfaces:**
- Consumes: `POST /api/kanban-individual { enabled }`; `GET /api/pipelines?view_as_user_id=&stage_scope=`; `tenant.kanban_individual` na sessão (`/me`).

- [ ] **Step 1: GeneralTab** — adicionar `kanban_individual?: boolean` ao tipo `TenantSettings` (linha 21) e um bloco Switch novo seguindo o padrão dos existentes (`round_robin_enabled`, linhas ~270), com diálogo de confirmação no padrão do commit b87369d (troca de modelo de atendimento) explicando: ativar clona o kanban atual para cada membro; desativar junta tudo de volta no modelo base. `onCheckedChange` → `api.post('/api/kanban-individual', { enabled: checked })` e atualizar estado com a resposta. Visível só para GERENTE/SUPER_ADMIN (o tab já é restrito; conferir e manter).
- [ ] **Step 2: Kanban page** — quando `tenant.kanban_individual`:
  - query de pipelines vira `queryKey: ['pipelines', viewAsApplied]` e `api.get('/api/pipelines', { params: viewAsApplied !== 'ALL' ? { view_as_user_id: viewAsApplied } : {} })`;
  - seletor Ver como (linha 1063): remover a opção "todos" nesse modo — default passa a ser o próprio usuário (`viewAsUserId` inicial = id do gestor, não `'ALL'`);
  - nada muda com o toggle OFF (flag ausente/false → código atual).
- [ ] **Step 3: settings/pipeline page** — quando `tenant.kanban_individual` e papel gestor: GET vira `api.get('/api/pipelines', { params: { stage_scope: 'base' } })` e um banner curto no topo: "Kanban individual ativo: esta tela edita o modelo base (template para novos membros). Cada membro edita as próprias colunas no kanban.". Sem toggle, tela atual.
- [ ] **Step 4: Verificar** — `npm run build` no workspace web (ou `npx turbo build --filter=web`) limpo; `npm run lint` limpo.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): kanban individual — switch em ajustes, ver-como no board e modelo base na tela de etapas"`.

---

### Task 8: Script one-shot da Cajuru

**Files:**
- Create: `apps/api/scripts/migrar-kanban-individual-cajuru.mjs`

**Interfaces:**
- Consumes: DB direto (mesmo padrão de `scripts/introspect-db.mjs`: lê `.env`, `DIRECT_URL`).
- Produces: execução `node scripts/migrar-kanban-individual-cajuru.mjs` (dry-run, default) e `... --apply`.

Lógica (tudo numa transação no `--apply`; constantes no topo):

```js
const TENANT = 'bb4953ac-b37f-4445-81c0-f54508c77141';
const ISAMARA = 'dc416756-a583-447b-9e62-cc63e132bf00';
const CORTE = '2026-08-27T00:00:00Z'; // colunas criadas a partir daqui são da Isamara
```

1. Guardas: aborta se `Tenant.kanban_individual` já true; aborta se existir `Stage.user_id != null` no tenant.
2. `antigas` = stages do tenant com `created_at < CORTE` (espera 9: Novo, Em contato, Qualificado, Ganho, Perdido, Aguardando orçamento, Retorno para cliente, SEM RETORNO, Empresa / Representantes — validar por contagem e nomes, abortar se divergir). `daIsamara` = as com `created_at >= CORTE` (espera 9).
3. `daIsamara` → `UPDATE Stage SET user_id = ISAMARA`.
4. Isamara ganha clones das 9 `antigas` (user_id=ISAMARA, `ordem`/campos copiados — a ordem atual do board já intercala, os clones herdam a `ordem` da antiga). Leads com `responsavel_id = ISAMARA` em cada antiga → clone correspondente. Leads dela nas 9 `daIsamara` não se movem (as colunas viraram dela).
5. Para cada outro membro ativo (Alex, Brendo, Jessyca, Lucas, admin — buscar por `tenant_id`, `ativo`, role OPERADOR/GERENTE/SUPER_ADMIN, id != ISAMARA): clones das 9 antigas; leads do membro em cada antiga → clone dele.
6. Leads de outros membros presos nas colunas `daIsamara` (~5): mover para o clone "Em contato" do respectivo dono ("Em Contato" duplicada casa por nome case-insensitive; as demais caem no mesmo fallback aprovado).
7. Leads com `responsavel_id` null: não mover (ficam na base; board query joga na primeira coluna).
8. `UPDATE Tenant SET kanban_individual = true`.
9. Dry-run imprime: por membro, colunas a criar e contagem de leads a mover por (origem → destino); total geral; e os ~5 leads órfãos com nome/dono/destino. `--apply` roda a transação e imprime o mesmo relatório do que FOI feito.

- [ ] **Step 1: Escrever o script** com a estrutura acima.
- [ ] **Step 2: Dry-run local** — `node scripts/migrar-kanban-individual-cajuru.mjs` e conferir o relatório contra os números conhecidos (9 antigas, 9 da Isamara, ~5 órfãos, contagens da spec).
- [ ] **Step 3: Commit** — `git commit -m "feat(api): script one-shot do kanban individual da Cajuru (dry-run + apply)"`.

---

### Task 9: Deploy + migração + smoke

**Files:** nenhum novo (operacional).

- [ ] **Step 1:** `npx turbo build` verde na raiz; `npx turbo lint` verde; `npx jest` verde em apps/api.
- [ ] **Step 2:** Merge/push para `master` (deploy do backend no VPS é manual — memória: falta `VPS_SSH_KEY` no Actions; usar o fluxo de deploy manual conhecido, ssh.exe do Windows). Vercel pega o web sozinho.
- [ ] **Step 3:** Rodar o script da Cajuru: dry-run, conferir relatório, `--apply`.
- [ ] **Step 4: Smoke (com o Yuri ou via conta de teste):**
  - login gestor Cajuru → kanban mostra board próprio com as 9 colunas antigas;
  - Ver como Isamara → 18 colunas dela, leads no lugar;
  - Ver como Alex/Jessyca/Lucas → 9 colunas antigas;
  - operador cria/renomeia coluna → só o board dele muda;
  - Ajustes mostra o switch ligado;
  - lead devolvido à nuvem aparece na primeira coluna com selo Disponível; claim leva para a coluna certa do novo dono.
- [ ] **Step 5:** Atualizar memória do projeto (estado da feature) e avisar o Yuri do resultado.

---

## Self-review (feita na escrita)

- Spec coberta: dados (T1), enable/disable (T2), toggle+sessão (T3), leitura (T4), escrita+pipeline novo (T5), remaps/nuvem/board/inbound (T6), frontend (T7), Cajuru (T8), deploy/smoke (T9). Limitações (views salvas, broadcasts) não geram task — documentadas na spec.
- Broadcast.stage_id anulado no disable: T2/step do disable. LeadInsight FK já é SetNull: sem task.
- Tipos consistentes: `stageForOwner(tenantId, ownerId, fromStageId)` usado igual em T2/T6; `stageScopeWhere` só em T4; `scope` no body só em T5/T7.
