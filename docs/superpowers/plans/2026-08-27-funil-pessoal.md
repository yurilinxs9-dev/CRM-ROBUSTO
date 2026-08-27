# Funil pessoal por operador — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** os dois formatos de trabalho — funil compartilhado do time e funil pessoal por operador — com lead novo caindo no funil do responsável e visibilidade dono+gestão. Spec: `docs/superpowers/specs/2026-08-27-funil-pessoal-design.md`.

**Architecture:** `Pipeline.owner_user_id String?` (null = compartilhado); listagem filtrada por papel; criação por operador força dono=ele; roteamento centralizado num método `moverParaFunilPessoal(leadId, responsavelId, tenantId)` chamado nos 4 pontos de atribuição (claim, reassign, round-robin de setor, criação com responsável); UI no dialog de funis + badge no seletor.

**Tech Stack:** o de sempre (NestJS/Prisma; Next/RQ/shadcn).

## Global Constraints

- NUNCA `any`. Jest `--maxWorkers=2`; tsc verde nos dois apps; `npm run build` no web.
- Migration manual idempotente em `apps/api/prisma/manual/` (padrão fase 4/5), aplicada no VPS ANTES do backend; `prisma generate` via `node ../../node_modules/prisma/build/index.js generate`.
- Visibilidade (spec verbatim): "não-gestor recebe `owner_user_id IS NULL OR owner_user_id = eu`. Gestor recebe tudo." Gestor = GERENTE/SUPER_ADMIN (mesmo `ehGestor` da guarda fina de updateStage).
- Roteamento (spec verbatim): mover só quando o responsável NOVO tem funil pessoal (o mais antigo por `created_at`) e o lead não está já nele; destino = 1ª etapa por `ordem` asc com `is_won=false AND is_lost=false`; NUNCA mover de volta sozinho. Funil pessoal sem etapa aberta ⇒ NÃO move (warn).
- Toda movimentação registra `LeadActivity` (`tipo: 'funil_pessoal'`, `user_id` do ator quando houver, `dados_antes/depois` com pipeline_id+estagio_id) + `emitLeadStageChanged`/`emitLeadUpdated` + `invalidateLeadsCache` (regra 8 do CLAUDE.md; ordem cache→WS).
- Fail-safe: falha do roteamento NUNCA quebra a atribuição (try/catch + warn; a atribuição em si já foi gravada).
- Branch `feat/funil-pessoal` de `master`. Commits `feat(api):`/`feat(web):`.

---

### Task 1: Migration + schema — Pipeline.owner_user_id

**Files:**
- Create: `apps/api/prisma/manual/2026-08-27-funil-pessoal.sql`
- Modify: `apps/api/prisma/schema.prisma` (model Pipeline; inversa em User `pipelines_pessoais Pipeline[]`)

**Interfaces:**
- Produces: `Pipeline.owner_user_id String?` + relação `owner User?` (`onDelete: SetNull`).

- [ ] **Step 1: SQL** (cabeçalho padrão da pasta; BEGIN/COMMIT):

```sql
-- Aplicar via psql -f ou statement a statement (todos idempotentes).

-- Funil pessoal por operador: dono do pipeline (null = compartilhado do time).
BEGIN;
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "owner_user_id" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Pipeline_owner_user_id_fkey') THEN
    ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_owner_user_id_fkey"
      FOREIGN KEY ("owner_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS "Pipeline_tenant_id_owner_user_id_idx" ON "Pipeline"("tenant_id", "owner_user_id");
COMMIT;
```

- [ ] **Step 2: schema.prisma** — em `Pipeline`: `owner_user_id String?` + `owner User? @relation("PipelinePessoal", fields: [owner_user_id], references: [id], onDelete: SetNull)` + `@@index([tenant_id, owner_user_id])`; em `User`: `pipelines_pessoais Pipeline[] @relation("PipelinePessoal")`. Conferir nome real da relação existente Pipeline↔Tenant antes (sem colidir nomes).
- [ ] **Step 3:** validate + generate + tsc verdes. Reverter churn de prisma format se houver.
- [ ] **Step 4: Commit** — `feat(api): schema — dono opcional do pipeline (funil pessoal)`

---

### Task 2: API pipelines — visibilidade, criação por operador e gestão pelo dono (TDD)

**Files:**
- Modify: `apps/api/src/modules/pipelines/pipelines.controller.ts`, `pipelines.service.ts`
- Test: `apps/api/src/modules/pipelines/pipelines.service.spec.ts` e `pipelines.roles.spec.ts`

**Interfaces:**
- Consumes: Task 1. `ehGestor` = `user.role === 'GERENTE' || user.role === 'SUPER_ADMIN'` (padrão já usado em updateStage).
- Produces:
  - `GET /pipelines` (método de listagem existente — localizar): não-gestor filtra `OR: [{ owner_user_id: null }, { owner_user_id: user.id }]`; gestor sem filtro. Resposta inclui `owner_user_id` e `owner: { select: { id, nome } }` (p/ badge).
  - `POST /pipelines`: decorator vira `@Roles(UserRole.OPERADOR)`; schema ganha `owner_user_id: z.string().uuid().nullable().optional()`; service: não-gestor ⇒ `owner_user_id = user.id` SEMPRE (ignora body); gestor ⇒ usa o body (validando que o user pertence ao tenant e está ativo; inválido ⇒ 400).
  - `PATCH /pipelines/:id`, `DELETE /pipelines/:id`, `POST /pipelines/:id/delete-with-move`, `archive`/`unarchive`: decorators viram `@Roles(UserRole.OPERADOR)` + guarda no service: não-gestor só passa se `pipeline.owner_user_id === user.id` (senão 403). Gestor: tudo. PATCH de não-gestor não pode alterar `owner_user_id` (403 se presente no body).
  - `duplicate` e `pipelines/reorder` continuam GERENTE.

- [ ] **Step 1: Failing tests:** (a) listagem: operador vê null+seus, não vê pessoal alheio; gestor vê tudo; owner no payload; (b) create por operador força owner=ele mesmo mesmo com body malicioso apontando outro; (c) create por gestor com owner de outro tenant/inativo ⇒ 400; sem owner ⇒ compartilhado; (d) PATCH/DELETE de funil pessoal alheio por operador ⇒ 403; do próprio ⇒ passa; compartilhado por operador ⇒ 403; (e) PATCH de operador com owner_user_id no body ⇒ 403; (f) roles spec atualizado (rotas de pipeline que abriram p/ OPERADOR + duplicate/reorder ainda GERENTE).
- [ ] **Step 2: RED.** **Step 3: Implementar.** **Step 4: GREEN** (`npx jest pipelines --maxWorkers=2` + tsc).
- [ ] **Step 5: Commit** — `feat(api): funil pessoal — visibilidade por dono e gestao pelo operador`

---

### Task 3: API leads — roteamento na atribuição (TDD)

**Files:**
- Modify: `apps/api/src/modules/leads/leads.service.ts`
- Test: `apps/api/src/modules/leads/` spec pertinente (seguir onde claim/reassign são testados; criar `leads.funil-pessoal.spec.ts` se não houver)

**Interfaces:**
- Consumes: Task 1 (campo). Pontos de atribuição no `leads.service.ts`: `claim` (l.~1320), `reassign` (l.~1368), round-robin de setor (l.~1465), criação de lead com `responsavel_id` (localizar no create).
- Produces: privado `moverParaFunilPessoal(leadId, responsavelId, tenantId, atorUserId: string | null)`: busca funil pessoal mais antigo do responsável (`owner_user_id = responsavelId, tenant_id, ativo/não-arquivado — conferir campo real`), 1ª etapa aberta por `ordem` asc; no-op silencioso se: sem funil pessoal, lead já nesse pipeline, sem etapa aberta (warn). Move com update de `pipeline_id + estagio_id + estagio_entered_at` + activity `funil_pessoal` (descricao: `Movido para o funil pessoal de <nome> ao assumir o lead`) + `invalidateLeadsCache` + `emitLeadStageChanged`. Try/catch no chamador: falha não desfaz a atribuição.

- [ ] **Step 1: Failing tests:** (a) claim por operador com funil pessoal ⇒ lead move p/ 1ª etapa aberta dele + activity + WS + cache; (b) claim sem funil pessoal ⇒ nada move; (c) reassign para operador com funil ⇒ move; reassign para o MESMO pipeline ⇒ no-op; (d) round-robin de setor ⇒ move para o funil do agente sorteado; (e) criação com responsavel_id ⇒ move; (f) funil pessoal só com etapas won/lost ⇒ no-op com warn; (g) erro do move não derruba o claim (claim retorna ok).
- [ ] **Step 2: RED.** **Step 3: Implementar.** **Step 4: GREEN** (`npx jest leads --maxWorkers=2` + tsc; suíte inteira antes do commit).
- [ ] **Step 5: Commit** — `feat(api): lead atribuido cai no funil pessoal do responsavel`

---

### Task 4: Web — dialog de funil com dono + badge no seletor + ajuda (paralela à T3 após T2)

**Files:**
- Modify: `apps/web/src/app/(dashboard)/kanban/page.tsx` (dialog de criar/editar funil + seletor)
- Modify: `apps/web/src/app/(dashboard)/ajuda/page.tsx` (parágrafo na seção Kanban)

**Interfaces:**
- Consumes: T2 (`owner_user_id`/`owner` no GET; POST aceita `owner_user_id` p/ gestor). Papel do usuário: mesmo store/fonte que o resto da página usa (localizar como a página sabe o papel; se não sabe, `useAuthStore`).

- [ ] **Step 1: Dialog criar funil** — gestor: select "Funil de:" com "Compartilhado (equipe)" + membros ativos (buscar do endpoint de team members já usado em Settings — copiar o fetch); operador: sem select, texto "Este funil será pessoal, só seu e da gestão." e POST sem owner (backend força). Editar funil: gestor pode trocar o dono (PATCH `owner_user_id`); operador não vê o campo.
- [ ] **Step 2: Seletor de funis** (kanban; conferir se radar/leads usam componente compartilhado — se sim, um lugar só): sufixo no nome — para o dono: `· pessoal`; para gestor: `· {owner.nome}`. Backend velho sem owner ⇒ sem sufixo, zero crash.
- [ ] **Step 3: Ajuda** — seção Kanban ganha 1 parágrafo: os dois formatos, quem vê o quê, e que lead atribuído cai no funil pessoal do responsável.
- [ ] **Step 4:** tsc + build 0 erros. **Step 5: Commit** — `feat(web): funil pessoal no dialog, badge no seletor e ajuda`

---

### Task 5: Deploy + smoke

- [ ] Suítes API completas + build web; merge master (sem push) → push.
- [ ] VPS: aplicar SQL ANTES do backend (padrão apply script; ALTER + DO $$ + INDEX) → build/up → health 200, zero P2022.
- [ ] Smoke: criar funil pessoal p/ a Isamara (Cajuru) via script ou UI; claim/reassign de um lead de teste ⇒ conferir que caiu na 1ª etapa do funil dela + activity `funil_pessoal`; listagem como operador não mostra funil pessoal alheio.
- [ ] Memória.

---

## Self-review (feito na escrita)

- Spec coberta: modelo (T1), criação/visibilidade/gestão (T2), roteamento nos 4 pontos com fail-safe (T3), UI+ajuda (T4). "Nunca mover de volta" garantido por só agir na atribuição com funil pessoal do NOVO responsável.
- Sem placeholders; tipos consistentes (owner_user_id string|null em T1=T2=T4; moverParaFunilPessoal privado da T3 não vaza contrato).
- Riscos aceitos: vários funis pessoais ⇒ usa o mais antigo (determinístico, documentado); lead movido pro funil pessoal some do funil padrão do kanban dos colegas (é o objetivo — carteira própria); duplicate/reorder de pipelines ficam GERENTE (não pedidos).
- Ordem: T1 → T2 → (T3 ∥ T4) → T5.
