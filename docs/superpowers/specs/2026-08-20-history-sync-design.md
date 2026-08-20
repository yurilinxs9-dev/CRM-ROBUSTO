# Sincronização de histórico estilo WhatsApp Web (UazAPI)

Data: 2026-08-20 · Status: aprovado pelo Yuri

## Problema

Queda de webhooks 15–17/ago (backend/nginx fora) deixou buraco permanente:
mensagens que o WhatsApp recebeu nunca entraram no CRM (ex.: Cajuru — chat
"Fernanda Greick" existe no aparelho, zero lead no banco). O CRM é ouvinte
passivo: webhook perdido = mensagem perdida pra sempre. Não existe nenhum
mecanismo de re-sync inbound (`messages-recovery` só reenvia OUTGOING).

## Fato habilitador (verificado ao vivo em 2026-08-20)

O servidor UazAPI (`https://jgtech.uazapi.com`, uazapiGO) guarda o histórico:

- `POST /chat/find` `{limit, offset, sort:"-wa_lastMsgTimestamp"}` + header
  `token` → chats com `wa_chatid`, `wa_isGroup`, `name`/`wa_contactName`,
  `wa_chatlid`, `wa_lastMsgTimestamp` (epoch ms). Paginado.
- `POST /message/find` `{chatid, limit, offset}` → mensagens no MESMO shape do
  webhook `message` (`messageType` PascalCase, `content` aninhado com
  URL/mediaKey/mimetype/seconds, `text`, `senderName`, `fromMe`, `messageid`,
  `messageTimestamp` epoch ms, `chatid`). `hasMore`/`nextOffset`. Mídia `.enc`
  + `mediaKey` — mesmo contrato que `media-crypto.ts` já decripta.

Logo: backfill pode sintetizar payloads idênticos aos do webhook e reusar o
pipeline inteiro (`extractFromUazapi` → fila `webhooks` → `saveIncomingMessage`
→ upsert UNIQUE por `whatsapp_message_id` composto com tenant).

## Componentes

### 1. `HistorySyncService` (`apps/api/src/modules/webhooks/`)

- Helpers puros em `history-sync.ts` (parse de `/chat/find`, decisão de quais
  chats têm buraco, corte de janela) — unit-testáveis sem IO.
- `syncInstance(instance, windowMs, opts)`:
  1. Pagina `/chat/find` ordenado por `-wa_lastMsgTimestamp`; para quando o
     chat mais recente da página já é mais velho que a janela. Pula grupos
     (`wa_isGroup`) e chats sem telefone resolvível.
  2. Por chat: compara `wa_lastMsgTimestamp` com a última `Message.created_at`
     do par (tenant, telefone). Sem lead ou DB atrás → tem buraco.
  3. Chat com buraco: pagina `/message/find` (limit 100) até cobrir a janela;
     enfileira cada mensagem na fila BullMQ `webhooks` como job
     `uazapi.messages` com `{message, token, backfill: true}`.
  4. Contato: se lead ficou com nome=telefone (placeholder), aplica
     `name`/`wa_contactName` do chat; persiste `wa_chatlid` se houver.
- Guardrails: concorrência 3 chats, caps por execução (chats e mensagens),
  timeout HTTP 12s, idempotente (rodar 2x não duplica — upsert).

### 2. Modo backfill no `saveIncomingMessage`

`SaveMessageInput.backfill?: { timestamp: Date }`. Quando presente:

- `created_at` da Message = `messageTimestamp` original (não `now()`);
- `ultima_interacao`/`last_customer_message_at` do lead só avançam (max), nunca
  retrocedem;
- NÃO incrementa `mensagens_nao_lidas`, NÃO dispara push/notificação, NÃO
  aciona rodízio/auto-ação de estágio — histórico não é evento novo;
- WebSocket: emite refresh de lead/chat ao final do sync, não por mensagem.

### 3. Gatilhos

| Gatilho | Janela | Como |
|---|---|---|
| Cron 30 min | 48 h | todas instâncias UazAPI conectadas; detecta queda silenciosa de webhook sozinho |
| Reconexão (`close`→`open` no connection update UazAPI) | 7 dias | enfileira sync da instância |
| Manual `POST /instances/:id/history-sync {days}` (admin/gerente) | 1–60 dias | backfill inicial de 30 dias em todas as instâncias (corrige Cajuru) |

### 4. Extractor

`extractFromUazapi`: caso `ReactionMessage` → `{type:'TEXT', content:'[reaction] <emoji>'}`
(paridade com Evolution).

## Fora de escopo

- Evolution API (Cajuru é 100% UazAPI; acks Evolution funcionam por webhook).
  Estrutura fica provider-scoped pra estender depois.
- Sincronizar deleções/edições retroativas.

## Erros

- UazAPI 4xx/5xx num chat → loga debug, segue pro próximo (próximo ciclo cobre).
- Instância sem token ou desconectada → pulada.
- Mensagem sem `messageid` → id sintético (`synthesizeMessageId`, já existe).

## Testes

- Unit: helpers de `history-sync.ts` (decisão de buraco, corte de janela,
  paginação), extractor ReactionMessage, `saveIncomingMessage` em modo backfill
  (timestamp preservado, sem unread/notificação, `ultima_interacao` não
  retrocede).
- Validação real: rodar backfill 30d na Cajuru e conferir "Fernanda Greick" +
  volume 15–17/ago.
