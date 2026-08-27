# Dedupe de mensagem por conversa + card de álbum honesto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mensagem encaminhada para várias conversas ao mesmo tempo (mesmo `whatsapp_message_id` em chats diferentes — caso real: vídeo da Jessyca p/ Paulo sumiu 26/08) passa a aparecer em TODAS as conversas; e o card "Album: N" do chat deixa de mostrar quadrados cinza eternos.

**Architecture:** unique de `Message` vira `(tenant_id, whatsapp_message_id, lead_id)` (afrouxamento — dados atuais nunca violam); o dedupe pré-efeito do inbound compara também o chat (mesmo wamid em chat DIFERENTE não é duplicata); acks/status por wamid viram `updateMany` (as N cópias recebem o status juntas — é a mesma mensagem). Front: bolha de "Album: N images/videos" rende linha discreta.

**Tech Stack:** o de sempre. Referência do caso real: WebhookLog 26/08 19:25:50, wamid `A5C7F710366DBBEE3ED8DBD8FEC184ED` presente nos leads 48bb51fd (Isamara Cajuru, OUTGOING jssyca) e ausente no 4bd769d1 (Paulo).

## Global Constraints

- NUNCA `any`. Jest `--maxWorkers=2`; tsc verde nos dois apps; build web verde.
- Migration manual idempotente (padrão da pasta), aplicada no VPS ANTES do backend. **DEPLOY SÓ COM LIBERAÇÃO EXPLÍCITA DO YURI** (ele pediu para segurar).
- Regra crítica 4 do CLAUDE.md reinterpretada conscientemente: "SEMPRE upsert por whatsapp_message_id (UNIQUE)" passa a ser "por (tenant, wamid, lead)" — o objetivo da regra (idempotência de re-emissão do MESMO chat) é preservado; o que muda é que chats distintos não competem mais.
- O caminho quente (saveIncomingMessage) não pode ganhar query extra no caso comum: o dedupe pré-efeito continua UMA leitura (findFirst por index (whatsapp_message_id) já existente + filtro de tenant), decidindo por comparação de chat em memória.
- Nada de mudança de comportamento para: notas internas, mensagens outgoing do próprio CRM (wamid gerado único), acks de status (agora updateMany — cópias sincronizadas), history-sync (mesma regra composta).

---

### Task 1: Migration + schema — unique composto

**Files:**
- Create: `apps/api/prisma/manual/2026-08-27-dedupe-por-conversa.sql`
- Modify: `apps/api/prisma/schema.prisma` (model Message ~l.461-527)

**Interfaces:**
- Produces: `@@unique([tenant_id, whatsapp_message_id, lead_id], name: "tenant_wamid_lead")`; o unique antigo `tenant_id_whatsapp_message_id` DEIXA de existir; `@@index([whatsapp_message_id])` permanece (lookup de ack).

- [ ] **Step 1: SQL idempotente** (cabeçalho padrão; BEGIN/COMMIT):

```sql
-- Aplicar via psql -f ou statement a statement (todos idempotentes).

-- Dedupe por conversa: mensagem encaminhada p/ varios chats (mesmo wamid)
-- existe uma vez POR chat. Afrouxamento: dados atuais nunca violam o novo.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS "Message_tenant_id_whatsapp_message_id_lead_id_key"
  ON "Message"("tenant_id", "whatsapp_message_id", "lead_id");
DROP INDEX IF EXISTS "Message_tenant_id_whatsapp_message_id_key";
COMMIT;
```

(Conferir no banco o nome REAL do índice/constraint antigo antes — se for constraint, `ALTER TABLE ... DROP CONSTRAINT IF EXISTS` no lugar do DROP INDEX; o implementer valida com introspect-db.mjs e ajusta o SQL, mantendo idempotência. ORDEM: cria o novo ANTES de dropar o velho — nunca fica sem proteção.)

- [ ] **Step 2: schema.prisma** — trocar `@@unique([tenant_id, whatsapp_message_id], name: "tenant_id_whatsapp_message_id")` por `@@unique([tenant_id, whatsapp_message_id, lead_id], name: "tenant_wamid_lead")`; comentários da região atualizados. `prisma generate` + tsc VÃO QUEBRAR os 7 call sites — esta task PODE deixar tsc vermelho; commit da task registra isso e a Task 2 (mesma branch, sequencial) conserta. Alternativa preferida: Tasks 1+2 num commit único se o implementer for o mesmo — NÃO: manter tasks separadas, mas a Task 1 NÃO roda tsc como gate (documentar no commit).
- [ ] **Step 3: Commit** — `feat(api): schema — dedupe de mensagem por conversa (tenant, wamid, lead)`

### Task 2: Call sites + dedupe pré-efeito por chat (TDD; MESMO implementer da T1, sequencial)

**Files:**
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts` (l.~404 dedupe pré-efeito; l.~678, ~732, ~775 upserts/acks), `apps/api/src/modules/webhooks/history-sync.service.ts` (l.~217, ~434)
- Test: specs correspondentes (inbound-message.service.spec.ts, history-sync.service.spec.ts)

**Interfaces:**
- Consumes: T1 (unique novo `tenant_wamid_lead`).
- Regras exatas:
  - Dedupe pré-efeito (antes de resolver lead): `message.findFirst({ where: { tenant_id, whatsapp_message_id }, select: { id, lead: { select: { telefone: true } } } })` — se existe E `lead.telefone === phone` do evento → duplicata do MESMO chat: return silencioso (comportamento atual). Se existe mas de OUTRO chat → NÃO é duplicata: segue o fluxo normal (vai criar no chat novo). Vários hits (pós-mudança pode haver N cópias): usar findFirst com filtro `lead: { telefone: phone }` direto no where — 1 query, decide na consulta.
  - Upserts de mensagem: `where: { tenant_wamid_lead: { tenant_id, whatsapp_message_id, lead_id } }` (lead já resolvido nesses pontos).
  - Acks/status por wamid (l.~732/775 e onde mais houver update por wamid — grep `whatsapp_message_id` no módulo messages também): virar `updateMany({ where: { tenant_id, whatsapp_message_id }, data })` — todas as cópias juntas. Emissões WS derivadas: emitir por cada lead afetado quando o código já emite por lead (buscar as cópias afetadas com select lead_id quando necessário para o emit; aceitável 1 query extra no ack).
- [ ] **Step 1: Failing tests:** (a) mesmo wamid, chats diferentes → duas Messages criadas (uma por lead), nenhuma engolida; (b) re-emissão do mesmo wamid no MESMO chat → dedupe silencioso (badge não infla — teste existente continua); (c) ack de status por wamid atualiza as duas cópias; (d) history-sync com wamid já existente NO MESMO lead → skip; em lead diferente → cria; (e) caso real de regressão nomeado no teste: "video encaminhado p/ 2 conversas nao some da segunda".
- [ ] **Step 2: RED.** **Step 3: Implementar.** **Step 4: GREEN** (`npx jest webhooks messages --maxWorkers=2` + suíte inteira + tsc). **Step 5: Commit** — `fix(api): mensagem encaminhada p/ varias conversas aparece em todas`

### Task 3: Web — card de álbum honesto

**Files:**
- Modify: o componente de bolha do chat que renderiza mensagens TEXT começando com "Album: " (localizar em apps/web/src — grep por como o chat rende `content`; o card com placeholders do print é o candidato)

- [ ] **Step 1:** Mensagem TEXT cujo content casa `/^Album: \d+/i`: renderizar como linha discreta estilo sistema (ícone 📎/Images + texto "Álbum — as fotos e vídeos aparecem abaixo" com o content original em title/tooltip), SEM placeholders de mídia. Se hoje não há tratamento especial (só os quadrados vindos de outro componente), simplesmente garantir que rende como texto simples. Investigar o componente real antes (o print mostra card com 2 quadrados — de onde vem?).
- [ ] **Step 2:** tsc + build. **Step 3: Commit** — `fix(web): card de album sem placeholders enganosos`

### Task 4: Review final + (deploy SEGURADO)

- [ ] Suítes completas; review final da branch (Fable); merge master SEM push. **Push + migration + rebuild SÓ após o Yuri liberar o deploy.** Smoke planejado: reencaminhar mídia p/ 2 chats de teste OU replay do payload real; conferir 2 cópias; card de álbum na conversa da Vaness.

## Self-review

- Caso real coberto por teste nomeado; regra de dedupe preservada por chat; acks sincronizam cópias; ordem create-antes-de-drop na migration; deploy explicitamente segurado.
- Riscos: nome real do índice antigo no banco (validação via introspect antes de escrever o DROP — mitigado no Step 1); volume de Messages (criar índice UNIQUE em tabela grande usa lock — avaliar `CREATE UNIQUE INDEX CONCURRENTLY` FORA de transação no apply script, statements separados; implementer decide e documenta).
- Ordem: T1→T2 mesmo implementer; T3 paralela; T4 gate.
