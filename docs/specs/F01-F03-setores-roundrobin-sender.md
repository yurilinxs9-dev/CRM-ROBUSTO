# F-01/F-02/F-03 — Setores, Round-Robin e Identificação de Remetente

Plano de implementação. Stack: NestJS + Prisma + Postgres(Supabase) + Next.js.
Deploy: backend VPS Docker (187.127.11.117), frontend Vercel.

## Decisões (reconciliação spec ↔ código real)

| Tema | Decisão | Motivo |
|------|---------|--------|
| `conversations.ai_blocked` | Vai em **`Lead`** (`ai_blocked Boolean @default(false)`) | Não existe tabela conversations; Lead é a conversa |
| Setor destino do lead | `sector_id` **nullable** em `WhatsappInstance`; fallback p/ setor "Sem Setor" do tenant | Realista (nº Vendas vs Suporte), robusto a troca de dono |
| Round-robin | Ativa quando `tenant.pool_enabled = true` (modo Compartilhado) | Reusa modelo Compartilhado/Individual; Individual segue dono da instância |
| Detecção IA | Flag `is_ai Boolean @default(false)` em `ApiKey` | Só keys marcadas viram `sender_type='ai'`; resto `system` |
| `sectors` multi-tenant | `tenant_id` obrigatório + `@@unique([tenant_id, name])` | Evita vazamento entre clientes |
| `sender_type` de mensagens | enum `SenderType { user ai system }`; default lógico no backend, **nunca** do cliente | Segurança: payload do cliente não dita sender_type |

### Mapa sender_type por origem
- `messages.sendText/sendAudio/sendMedia/createInternalNote` via JWT (controller humano) → **`user`** + `sender_id = caller.id` → seta `lead.ai_blocked = true`
- `public-api.sendMessage` (API key `is_ai=true`) → **`ai`** → não toca ai_blocked
- `public-api.sendMessage` (API key `is_ai=false`) → **`system`** → neutro
- `automation.service` (cadência/auto) → **`system`** → neutro
- webhook inbound, cliente (`INCOMING`) → **`system`** (neutro; IA deve poder responder cliente)
- webhook inbound `isFromMe` nativo do celular (humano respondeu pelo telefone, sem row local) → **`user`** → seta ai_blocked

## Modelo de dados (migration única, ordenada)

```prisma
enum SenderType { user ai system }

model Sector {
  id         String   @id @default(uuid())
  tenant_id  String
  tenant     Tenant   @relation(fields: [tenant_id], references: [id], onDelete: Cascade)
  name       String
  active     Boolean  @default(true)   // soft delete
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt
  users      User[]
  instances  WhatsappInstance[]
  queue_pointer QueuePointer?
  @@unique([tenant_id, name])
  @@index([tenant_id, active])
}

model QueuePointer {
  sector_id     String   @id
  sector        Sector   @relation(fields: [sector_id], references: [id], onDelete: Cascade)
  current_index Int      @default(0)
  updated_at    DateTime @updatedAt
}

model AssignmentLog {
  id         String   @id @default(uuid())
  tenant_id  String
  sector_id  String
  lead_id    String
  user_id    String?       // null = entrou em espera (setor sem ativos)
  reason     String        // 'round_robin' | 'waiting_no_agents' | 'skip_inactive'
  created_at DateTime @default(now())
  @@index([tenant_id, created_at])
  @@index([sector_id, created_at])
}

// User: + sector_id String?  (nullable na migration; backfill; depois NOT NULL)
//       + sector   Sector? @relation(...)
// WhatsappInstance: + sector_id String? + sector Sector? @relation(...)
// Lead: + ai_blocked Boolean @default(false)
// Message: + sender_type SenderType @default(system) + sender_id String?
// ApiKey: + is_ai Boolean @default(false)
```

### Estratégia de migration (sem perda — produção Supabase, usar directUrl)
1. Cria tabelas `Sector`, `QueuePointer`, `AssignmentLog` + enum `SenderType`.
2. Adiciona colunas novas **nullable** (`User.sector_id`, `Instance.sector_id`, `Lead.ai_blocked`, `Message.sender_type`, `Message.sender_id`, `ApiKey.is_ai`).
3. **Backfill**: por tenant, cria Sector "Sem Setor"; `UPDATE User SET sector_id = <setor do tenant>`. `UPDATE Message SET sender_type = CASE WHEN sent_by_user_id IS NOT NULL THEN 'user' ELSE 'system' END` (histórico: humano conhecido vira user, resto system).
4. Aplica `NOT NULL` em `User.sector_id` só após backfill. `Message.sender_type` já default `system`.
5. Defaults: `Lead.ai_blocked=false`, `ApiKey.is_ai=false` — sem backfill.

> Migrations divididas em 2 arquivos: (A) estrutura+nullable, (B) backfill+NOT NULL, p/ rodar backfill entre elas com `scripts/db-exec.mjs`.

## Backend

### F-01 Setores — módulo novo `modules/sectors`
- `sectors.service.ts`: list(active, tenant), create, update(name), softDelete (active=false).
- `sectors.controller.ts`: `GET/POST/PUT/DELETE /api/sectors`, guard `@Roles(GERENTE)` (admin do tenant).
- Zod schemas (name 1..80).
- `users.service`: `createTeamMember`/`updateTeamMember` passam a exigir/aceitar `sector_id`; validar que o setor é do tenant e ativo. Controller schemas (+`sector_id` em create, opcional em update).
- `TEAM_SELECT` + sector { id, name }.

### F-02 Round-robin — `modules/queue/assignment.service.ts`
- Método `assignBySector(tx, tenantId, sectorId, leadId)`:
  - `SELECT ... FOR UPDATE` em `QueuePointer` (upsert se ausente) dentro de transação.
  - usuários ativos do setor `ORDER BY id`. Vazio → log `waiting_no_agents`, notifica admin (GERENTE/SUPER_ADMIN), retorna null.
  - escolhe `users[current_index % n]`; `current_index = (current_index+1) % n`; log `round_robin`.
  - retorna userId.
- Integração em `webhook.processor.ts` (criação do lead): quando `pool_enabled` e não-ownerIsManager, em vez de `responsavel_id=null`, resolve setor da instância (ou "Sem Setor") e chama `assignBySector` dentro da mesma transação do upsert do lead. Mantém claim humana (não sobrescreve se já tem dono).
- Reinício não perde posição: ponteiro é persistido (já é tabela). ✔

### F-03 sender_type / ai_blocked
- `messages.service.sendText/sendAudio/sendMedia` ganham 4º arg `opts?: { senderType?: SenderType }` (default `'user'`). Grava `sender_type` + `sender_id` (user.id quando 'user', senão null). Quando resolved 'user' → `lead.ai_blocked=true` (update no mesmo fluxo) + emite WS.
- `createInternalNote` → `system` (nota interna não bloqueia).
- `public-api.service.sendMessage`: lê `req.apiAuth` → se key `is_ai` passa `senderType:'ai'`, senão `'system'`. (ApiAuth precisa carregar `is_ai` — incluir no guard.)
- `automation.service`: passa `senderType:'system'`.
- webhook inbound: `INCOMING` → `system`; `isFromMe` sem row local (nativo) → `user` + ai_blocked=true.
- **Guarda da IA**: `public-api.sendMessage` quando `is_ai` → checar `lead.ai_blocked`; se true, retorna 200 `{ skipped: true, reason: 'ai_blocked' }` sem enviar.
- Reset: novo endpoint `PATCH /api/leads/:id/ai-block { blocked: boolean }` (JWT, OPERADOR+) e ação no chat. Só humano/admin reseta.

## Frontend (Next.js / Vercel)
- `lib/api` hooks: `useSectors()`.
- Formulário de usuário (criar/editar membro): dropdown Setor populado por `GET /api/sectors`; submit bloqueado sem setor.
- Tela admin de setores: `app/(dashboard)/settings/sectors` (ou em /admin do tenant) — CRUD, soft delete some do dropdown mas preserva histórico.
- (Instâncias) seletor de setor por instância.
- Chat: badge sender_type (humano/IA/sistema) na bolha + toggle "IA bloqueada" com reset.

## Critérios de aceite (testes)
- F-01: criar usuário sem setor → 400. Setor inativo some do dropdown, usuários vinculados intactos. Migration sem perda.
- F-02: 2 vendedores, 5 leads → A,B,A,B,A (teste com `scripts/`). Restart mantém índice. Sem duplicação concorrente (lock).
- F-03: msg humano → `user` + ai_blocked=true. msg IA → `ai`, ai_blocked inalterado. IA não envia com ai_blocked=true. payload do cliente não força sender_type (backend sobrescreve).

## Ordem de execução
1. schema.prisma + 2 migrations + backfill script → validar local.
2. Backend módulos (sectors, queue, messages opts, public-api, automation, webhook).
3. `npx tsc --noEmit` (api) verde.
4. Frontend telas + hooks. `tsc --noEmit` (web) verde.
5. Deploy: migration em produção (directUrl) → backend VPS (docker build/up) → frontend Vercel.
6. Smoke test round-robin + ai_blocked em produção.
```
