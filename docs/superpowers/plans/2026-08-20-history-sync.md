# History Sync UazAPI (espelho WhatsApp Web) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CRM re-sincroniza histórico inbound/outbound do servidor UazAPI (chats + mensagens + contatos) para eliminar buracos causados por queda de webhooks — automático (cron + reconexão) e manual (endpoints).

**Architecture:** Novo `HistorySyncService` (módulo próprio `HistorySyncModule` em `apps/api/src/modules/webhooks/`) pagina `POST /chat/find` e `POST /message/find` da UazAPI e re-injeta cada mensagem na fila BullMQ `webhooks` como job `uazapi.messages` com flag `backfill: true`. O pipeline existente (`UazapiEventsHandler.handleUazapiMessage` → `InboundMessageService.saveIncomingMessage`) ganha um modo backfill que preserva o timestamp original e suprime efeitos colaterais de "mensagem nova" (unread, push, webhooks de saída, round-robin). Dedupe garantido pelo upsert UNIQUE `(tenant_id, whatsapp_message_id)` já existente.

**Tech Stack:** NestJS 10, BullMQ, Prisma, @nestjs/axios (HttpService), Jest. Servidor UazAPI: uazapiGO em `UAZAPI_BASE_URL` (default `https://jgtech.uazapi.com`), auth por header `token` por instância (`config.uazapi_token`).

## Global Constraints

- NUNCA `any` no TypeScript (CLAUDE.md regra 2).
- NUNCA processar webhook sincronamente — mensagens backfilled entram pela fila BullMQ `webhooks` (regra 1).
- SEMPRE upsert por `whatsapp_message_id` (UNIQUE composto com tenant) — regra 4.
- Zod para validação de input de endpoint (regra 7).
- Testes: Jest, padrão dos specs existentes no repo (mocks na borda, sem banco).
- Rodar testes: `cd apps/api && npx jest <arquivo> --silent`.
- Commits frequentes, mensagens em pt-BR estilo `feat:`/`fix:` como o log atual.
- NUNCA rodar `prisma migrate deploy` / `db push` (CLAUDE.md P3009). Este plano NÃO altera schema — zero migrations.

## Shapes verificados ao vivo (2026-08-20, produção jgtech.uazapi.com)

`POST /chat/find` body `{limit, offset, sort:"-wa_lastMsgTimestamp"}`, header `token`:
```json
{"chats":[{"wa_chatid":"553186332984@s.whatsapp.net","wa_chatlid":"126740374524068@lid",
  "wa_isGroup":false,"name":"Ricardo Borges Tapetes","wa_contactName":"Ricardo Borges Tapetes",
  "wa_lastMsgTimestamp":1787231638000,"wa_unreadCount":0, "...": "..."}]}
```

`POST /message/find` body `{chatid, limit, offset}`, header `token`:
```json
{"hasMore":true,"nextOffset":2,"messages":[{"chatid":"553186332984@s.whatsapp.net",
  "messageid":"2A0D500C6BD8A2B63ED0","fromMe":false,"messageTimestamp":1787231638000,
  "messageType":"Conversation","text":"...","content":{"text":"..."},
  "senderName":"RICARDO BORGES","sender_pn":"553186332984@s.whatsapp.net",
  "status":"Played","isGroup":false}]}
```
`messages` vem em ordem DESC de `messageTimestamp` (mais novo primeiro). `content` de mídia carrega `URL` (`.enc`), `mediaKey`, `mimetype`, `seconds` — mesmo contrato do webhook ao vivo que `extractFromUazapi` + `media-crypto.ts` já tratam.

---

### Task 1: Helpers puros de sync (`history-sync.ts`)

**Files:**
- Create: `apps/api/src/modules/webhooks/history-sync.ts`
- Test: `apps/api/src/modules/webhooks/history-sync.spec.ts`

**Interfaces:**
- Produces: `SyncChat { chatid: string; phone: string; name: string | null; lidJid: string | null; lastMsgTs: number }`, `parseChatsPage(raw: unknown): SyncChat[]`, `chatHasGap(chat: SyncChat, dbLastMs: number | null, sinceMs: number): boolean`, `parseFindMessages(raw: unknown): { messages: Obj[]; hasMore: boolean; nextOffset: number }`, `messageTs(m: Obj): number`, `backfillJobPayload(message: Obj, token: string): Obj`

Regras dos helpers:
- `parseChatsPage`: descarta grupos (`wa_isGroup === true`), chats sem `wa_chatid` terminando em `@s.whatsapp.net`, telefone = dígitos antes do `@` (8–13 dígitos, senão descarta). `name` = `wa_contactName || name || null` (string não-vazia). `lidJid` = `wa_chatlid` se termina em `@lid`.
- `chatHasGap`: `chat.lastMsgTs >= sinceMs` E (`dbLastMs === null` OU `chat.lastMsgTs > dbLastMs + 2000`) — margem de 2s pra clock skew.
- `parseFindMessages`: extrai `messages` array (default `[]`), `hasMore` boolean, `nextOffset` number (default `offset+len`).
- `messageTs`: `messageTimestamp` numérico em ms; valores em segundos (< 10^12) multiplicados por 1000; ausente → 0.
- `backfillJobPayload`: `{ event: 'uazapi.messages', token, message, backfill: true }`.

- [ ] Step 1: escrever testes cobrindo: parse de página real (fixture do shape acima), grupo descartado, telefone inválido descartado, gap true/false (sem lead, atrás, em dia, margem 2s), lastMsgTs fora da janela, parseFindMessages com/sem hasMore, messageTs em segundos vs ms, payload do job.
- [ ] Step 2: `npx jest history-sync.spec --silent` → FAIL (módulo não existe).
- [ ] Step 3: implementar helpers puros (sem IO, sem Nest).
- [ ] Step 4: `npx jest history-sync.spec --silent` → PASS.
- [ ] Step 5: commit `feat(api): helpers puros do history sync UazAPI`.

### Task 2: ReactionMessage no extractor UazAPI

**Files:**
- Modify: `apps/api/src/modules/webhooks/message-extractor.ts` (switch de `extractFromUazapi`, antes do `default`)
- Test: `apps/api/src/modules/webhooks/message-extractor.spec.ts`

- [ ] Step 1: teste — `extractFromUazapi({ messageType: 'ReactionMessage', content: { text: '👍' } })` → `{ type: 'TEXT', content: '[reaction] 👍' }`; variação com `text` flat.
- [ ] Step 2: rodar → FAIL (`[unsupported: ReactionMessage]`).
- [ ] Step 3: `case 'reactionmessage': return { type: 'TEXT', content: `[reaction] ${asStr(contentObj?.text) ?? text ?? ''}`.trim() };`
- [ ] Step 4: rodar → PASS.
- [ ] Step 5: commit `fix(api): reacao UazAPI vira [reaction] em vez de [unsupported]`.

### Task 3: Modo backfill em `saveIncomingMessage` + passthrough no handler

**Files:**
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts`
- Modify: `apps/api/src/modules/webhooks/uazapi-events.handler.ts` (`handleUazapiMessage`)
- Test: `apps/api/src/modules/webhooks/inbound-message.service.spec.ts` (estender harness existente)

**Interfaces:**
- Produces: `SaveMessageInput.backfill?: { timestamp: Date }`.
- `handleUazapiMessage` lê `payload.backfill === true` → `backfill: { timestamp: new Date(messageTs(message)) }` (usa `messageTs` da Task 1).

Comportamento com `backfill` presente (`ts` = `backfill.timestamp`, `recent` = `Date.now() - ts < 3_600_000`):
1. Lead upsert `create`: `ultima_interacao: ts`, `last_customer_message_at: isFromMe ? undefined : ts`.
2. Lead upsert `update`: SÓ `whatsapp_lid` — sem `ultima_interacao`, sem increment de `mensagens_nao_lidas`, sem `last_*_message_at`. Depois, avanço condicional (nunca retrocede):
   `updateMany({ where: { id: lead.id, ultima_interacao: { lt: ts } }, data: { ultima_interacao: ts, ...(isFromMe ? { last_agent_message_at: ts } : { last_customer_message_at: ts }) } })`.
3. Pular: bloco echo-dedup fromMe (upsert já dedupa), `blockAi`, round-robin/`assignBySector`/`notifyDistributed`/`notifyNoAgents` (auto-assign simples ao dono da instância CONTINUA), `syncLeadFromActive`+emit, `outboundWebhooks.dispatchMessageCreated`, push + notificações in-app.
4. Message upsert `create`: `created_at: ts` (campo aceita set explícito; default(now()) só cobre ausência).
5. `emitNewMessage` + `invalidateLeadsCache`: só quando `recent` (recupera queda ao vivo sem storm de histórico velho).
6. Manter: `conversations.resolveForInbound` com `occurredAt: ts`, `broadcastReply.registerCustomerReply` (resposta perdida do cliente ainda deve sair da fila de follow-up), mídia (`processMediaInBackground`), heal de nome + `syncProfileSafe`.

- [ ] Step 1: testes novos no spec existente (reusar `makeMocks()`): (a) backfill seta `created_at` do message create = ts e `ultima_interacao` create = ts; (b) backfill NÃO incrementa `mensagens_nao_lidas` e NÃO chama `push.sendToUsers`/`notification.create`/`dispatchMessageCreated`; (c) backfill antigo (ts > 1h atrás) NÃO chama `emitNewMessage`; backfill recente chama; (d) `lead.updateMany` chamado com `ultima_interacao: { lt: ts }`; (e) sem backfill, comportamento atual intacto (increment unread, emit) — regressão.
- [ ] Step 2: rodar spec → novos FAIL, antigos PASS.
- [ ] Step 3: implementar (guardas `if (!backfill)` nos blocos pulados; extrair `const occurredAt = backfill?.timestamp ?? new Date()` e usar nos pontos 1/4/`resolveForInbound`).
- [ ] Step 4: rodar spec inteiro → PASS.
- [ ] Step 5: passthrough no handler UazAPI (5 linhas) + teste? Handler não tem spec próprio — cobrir via teste de integração leve no próprio spec do inbound é suficiente; validação real na Task 6.
- [ ] Step 6: commit `feat(api): modo backfill no inbound (timestamp original, sem notificacao)`.

### Task 4: `HistorySyncService` + módulo + cron + gatilho de reconexão

**Files:**
- Create: `apps/api/src/modules/webhooks/history-sync.service.ts`
- Create: `apps/api/src/modules/webhooks/history-sync.module.ts`
- Modify: `apps/api/src/modules/webhooks/webhooks.module.ts` (importa HistorySyncModule)
- Modify: `apps/api/src/modules/webhooks/uazapi-events.handler.ts` (gatilho close→open)
- Test: `apps/api/src/modules/webhooks/history-sync.service.spec.ts`

**Interfaces:**
- Produces: `HistorySyncService.syncInstance(instanceId: string, windowMs: number): Promise<SyncSummary>` onde `SyncSummary = { chats_scanned: number; chats_synced: number; messages_enqueued: number }`; `syncAllUazapi(windowMs: number): Promise<SyncSummary[]>`.
- `HistorySyncModule` exporta `HistorySyncService`; imports: `HttpModule`, `BullModule.registerQueue({ name: 'webhooks' })`.

Comportamento `syncInstance`:
1. Carrega instância; sem `config.uazapi_token` → retorna zeros.
2. Pagina `POST /chat/find` `{limit: 100, offset, sort: '-wa_lastMsgTimestamp'}` header `token`, timeout 12s. Para quando: página vazia, ou TODOS os chats da página têm `lastMsgTs < since`, ou `chats_scanned >= MAX_CHATS_PER_RUN` (400).
3. Por chat (`parseChatsPage`): busca último `Message.created_at` do par (tenant, telefone): `prisma.message.findFirst({ where: { tenant_id, lead: { telefone: chat.phone, tenant_id } }, orderBy: { created_at: 'desc' }, select: { created_at: true } })`. `chatHasGap` false → próximo.
4. Chat com gap: pagina `POST /message/find` `{chatid, limit: 100, offset}` até `messageTs < since` ou `hasMore false` ou cap `MAX_MSGS_PER_CHAT` (500). Cada mensagem não-grupo com `messageTs >= since`: `webhookQueue.add('uazapi.messages', backfillJobPayload(m, token), { jobId: 'bf-' + instanceId + '-' + messageid, attempts: 3 })`. Erro `jobId` duplicado → ignorar (dedupe entre execuções).
5. Contato: se chat.name e lead existente com `nome === telefone` → `lead.updateMany({ where: { tenant_id, telefone, nome: telefone }, data: { nome: chat.name } })`; `whatsapp_lid` preenchido se null e `chat.lidJid`.
6. Erro HTTP num chat → `logger.debug`, segue. Erro no `/chat/find` → aborta execução com warn (próximo ciclo tenta).
7. Guard reentrância: `Set<string>` de instanceIds em sync; já rodando → retorna zeros.
8. Concorrência: chats sequenciais (fila absorve o paralelismo do processamento). Sem sleep artificial.

Cron: `@Cron(CronExpression.EVERY_30_MINUTES)` → `syncAllUazapi(48h)`: todas as instâncias com `config.uazapi_token` e `status: 'open'`.

Gatilho de reconexão em `handleUazapiConnectionUpdate`: capturar status anterior (o `findInstanceByUazapiToken` já retorna a linha com `status` antigo). Se `instance.status !== 'open' && status === 'open'` → `void this.historySync.syncInstance(instance.id, 7 * 24 * 3600_000)` com `.catch(log)`. Injetar `HistorySyncService` no `UazapiEventsHandler`.

- [ ] Step 1: testes com mocks (HttpService.post jest.fn, Queue.add jest.fn, prisma mock): (a) instância sem token → zeros, sem HTTP; (b) chat com gap → enfileira N jobs `uazapi.messages` com `backfill: true` e jobId determinístico; (c) chat em dia → zero jobs; (d) paginação para quando página só tem chats fora da janela; (e) mensagens fora da janela não enfileiradas; (f) nome placeholder atualizado; (g) reentrância retorna zeros.
- [ ] Step 2: rodar → FAIL.
- [ ] Step 3: implementar service + module; wiring no WebhooksModule; gatilho no handler.
- [ ] Step 4: rodar spec novo + `npx jest webhooks --silent` (regressões) → PASS.
- [ ] Step 5: commit `feat(api): history sync UazAPI — cron 30min + sync na reconexao`.

### Task 5: Endpoints manuais (tenant e plataforma)

**Files:**
- Modify: `apps/api/src/modules/instances/instances.controller.ts` + `instances.module.ts` (import HistorySyncModule)
- Modify: `apps/api/src/modules/platform-admin/platform-admin.controller.ts` + `platform-admin.module.ts`
- Test: cobertura via guards já testados; validação Zod inline testada em Task 6 (smoke real). Sem spec novo.

**Interfaces:**
- Consumes: `HistorySyncService.syncInstance` / `syncAllUazapi` (Task 4).

- `POST /instances/:nome/history-sync` `@Roles(UserRole.GERENTE)`: body Zod `{ days?: number }` (int 1–60, default 30). Resolve instância por `nome` + `tenant_id` do `req.user`; 404 se não achar. Dispara `void syncInstance(...)` e retorna `{ started: true, days }` imediato (sync é longo; resultado vai pro log).
- `POST /platform/history-sync` (PlatformAdminGuard, mesmo padrão das rotas existentes do controller): body `{ days?: number }` idem → `void syncAllUazapi(...)` → `{ started: true, days }`.

- [ ] Step 1: implementar os dois endpoints seguindo o padrão de rota/guard/Zod dos controllers (ler as rotas vizinhas antes).
- [ ] Step 2: `npx tsc --noEmit` no apps/api (ou `npm run build`) → limpo.
- [ ] Step 3: commit `feat(api): endpoints manuais de history sync (gerente e plataforma)`.

### Task 6: Build, deploy e validação real (Cajuru)

**Files:** nenhum novo — operação.

- [ ] Step 1: `cd apps/api && npx jest --silent` (suite inteira) + `npm run build` → verde.
- [ ] Step 2: push; deploy do backend no VPS conforme runbook `docs/PROJECT_CONTEXT.md` (GitHub Actions ou manual via `/c/WINDOWS/System32/OpenSSH/ssh.exe crm-vps`).
- [ ] Step 3: disparar `POST /platform/history-sync {days: 30}` com JWT de super admin da plataforma.
- [ ] Step 4: validar no banco (script read-only, padrão `introspect-db.mjs`): (a) lead "Fernanda Greick" existe no tenant Cajuru com mensagens; (b) contagem de INCOMING da Cajuru em 15–17/ago subiu de 11/2/40 para volume plausível; (c) zero duplicatas: `SELECT tenant_id, whatsapp_message_id, count(*) FROM "Message" GROUP BY 1,2 HAVING count(*) > 1` vazio (além das pré-existentes, se houver).
- [ ] Step 5: conferir logs do backend (`docker logs crm-backend`) — sem erros de sync; cron 30min ativo.
- [ ] Step 6: commit final de docs se algo mudou + atualizar memória do projeto.

## Self-review

- Spec coverage: backfill manual (Task 5+6), cron 48h (Task 4), reconexão (Task 4), modo backfill sem side effects (Task 3), contatos (Task 4 passo 5 + heal existente), ReactionMessage (Task 2), guardrails (caps/timeout/reentrância Task 4), fora de escopo Evolution — ok.
- Sem placeholders; tipos consistentes (`SyncChat`, `SyncSummary`, `backfill?: { timestamp: Date }` usados igualmente nas tasks 1/3/4/5).
- Zero migrations — respeita o aviso P3009.
