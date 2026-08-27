-- Aplicar via psql -f ou statement a statement (todos idempotentes).
--
-- Dedupe de mensagem POR CONVERSA.
--
-- Bug real: um video encaminhado por um vendedor para 2 conversas ao mesmo
-- tempo chega nos dois webhooks com o MESMO whatsapp_message_id (o WhatsApp
-- reaproveita a id no encaminhamento em lote). Com o unique
-- (tenant_id, whatsapp_message_id), a copia do SEGUNDO chat caia no caminho de
-- dedupe/update e a mensagem simplesmente nunca aparecia la.
-- Evidencia: wamid A5C7F710366DBBEE3ED8DBD8FEC184ED existe como VIDEO OUTGOING
-- no lead 48bb51fd (instancia jssyca); o evento do mesmo wamid para o lead
-- 4bd769d1 (chat 553798769016) foi processado sem criar Message nenhuma.
--
-- Passa a ser (tenant_id, whatsapp_message_id, lead_id): uma copia POR conversa.
-- E AFROUXAMENTO puro — todo dado que satisfazia o unique antigo satisfaz o
-- novo, entao a criacao do indice nao pode falhar por duplicidade.
--
-- ORDEM: cria o NOVO antes de derrubar o VELHO — a tabela nunca fica um
-- instante sem protecao contra duplicata.
--
-- ------------------------------------------------------------------------
-- ALTERNATIVA PARA TABELA GRANDE (Message tem milhoes de linhas)
-- ------------------------------------------------------------------------
-- O CREATE UNIQUE INDEX abaixo bloqueia ESCRITA na Message enquanto constroi
-- (lock SHARE). Se a janela for inaceitavel em producao, o operador usa a
-- variante CONCURRENTLY — que NAO roda dentro de transacao. O apply script
-- executa statement a statement, entao basta rodar os de baixo FORA de
-- qualquer BEGIN/COMMIT, um por vez:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--     "Message_tenant_id_whatsapp_message_id_lead_id_key"
--     ON "Message"("tenant_id", "whatsapp_message_id", "lead_id");
--
--   -- se o objeto antigo for CONSTRAINT (e nao indice solto), o DROP INDEX
--   -- nao o remove — e ainda ERRA ("constraint requires index"). Rode antes:
--   ALTER TABLE "Message"
--     DROP CONSTRAINT IF EXISTS "Message_tenant_id_whatsapp_message_id_key";
--   -- (essa forma pega ACCESS EXCLUSIVE por instantes; nao existe
--   --  DROP CONSTRAINT CONCURRENTLY)
--
--   DROP INDEX CONCURRENTLY IF EXISTS "Message_tenant_id_whatsapp_message_id_key";
--
-- Se o CREATE ... CONCURRENTLY falhar no meio, ele deixa um indice INVALID
-- para tras. Limpe e repita:
--   DROP INDEX IF EXISTS "Message_tenant_id_whatsapp_message_id_lead_id_key";
-- ------------------------------------------------------------------------

BEGIN;

-- 1) NOVO unique primeiro (nome = o que o Prisma geraria para
--    @@unique([tenant_id, whatsapp_message_id, lead_id])).
CREATE UNIQUE INDEX IF NOT EXISTS "Message_tenant_id_whatsapp_message_id_lead_id_key"
  ON "Message"("tenant_id", "whatsapp_message_id", "lead_id");

-- 2) Derruba o antigo. O nome real no banco pode ser um indice solto OU uma
--    constraint UNIQUE com indice de apoio (depende de ter nascido por
--    `db push` ou por migration). Trata os dois casos, nesta ordem:
--    a constraint PRIMEIRO, porque `DROP INDEX` num indice que apoia
--    constraint nao e no-op — ele ERRA. Com a constraint fora, o DROP INDEX
--    vira no-op e a mesma SQL serve para os dois formatos, sempre idempotente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Message_tenant_id_whatsapp_message_id_key'
      AND conrelid = '"Message"'::regclass
  ) THEN
    ALTER TABLE "Message" DROP CONSTRAINT "Message_tenant_id_whatsapp_message_id_key";
  END IF;
END
$$;

DROP INDEX IF EXISTS "Message_tenant_id_whatsapp_message_id_key";

-- 3) @@index([whatsapp_message_id]) NAO e tocado: continua sendo o lookup do
--    ack/eco por wamid sozinho (sem tenant), a query mais chamada do sistema.

COMMIT;
