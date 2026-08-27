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
-- Estado auditado no banco de producao (read-only, pg_indexes/pg_constraint):
--   * "Message_tenant_id_whatsapp_message_id_key" existe como UNIQUE INDEX
--     PURO — nao ha constraint correspondente (pg_constraint vazio pra ele).
--   * "Message_whatsapp_message_id_key" (legado global do 0001_init) NAO
--     existe. O DROP dele aqui e so cinto de seguranca para ambiente
--     restaurado de backup antigo.
-- Os guards de constraint continuam no arquivo: custam zero e cobrem um banco
-- que tenha nascido por migration em vez de db push.
--
-- ===========================================================================
-- PROCEDIMENTO DE DEPLOY — FASEADO, OBRIGATORIO
-- ===========================================================================
-- NUNCA rode este arquivo inteiro com o backend VELHO no ar. Derrubar o unique
-- antigo enquanto o codigo antigo atende significa (a) upsert do Prisma sem o
-- indice que ele espera no ON CONFLICT e (b) uma janela em que o dedupe que o
-- codigo acha que tem nao existe mais. As fases abaixo nunca deixam o banco
-- sem protecao e nunca deixam codigo e indice em desacordo.
--
-- FASE A — backend VELHO ainda no ar, sem downtime.
--   Cria o indice novo. E um afrouxamento: o unique antigo continua valendo e
--   o novo nunca dispara sozinho, entao o codigo velho segue correto.
--   CONCURRENTLY NAO roda dentro de transacao — execute solto, fora de
--   qualquer BEGIN/COMMIT:
--
--     CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--       "Message_tenant_id_whatsapp_message_id_lead_id_key"
--       ON "Message"("tenant_id", "whatsapp_message_id", "lead_id");
--
--   Se falhar no meio, ele deixa um indice INVALID para tras. Limpe e repita:
--     DROP INDEX IF EXISTS "Message_tenant_id_whatsapp_message_id_lead_id_key";
--   Confirmar antes de seguir (indisvalid = false):
--     SELECT c.relname, i.indisvalid FROM pg_class c
--       JOIN pg_index i ON i.indexrelid = c.oid
--      WHERE c.relname = 'Message_tenant_id_whatsapp_message_id_lead_id_key';
--
-- FASE B — parar o backend:
--     docker compose stop crm-backend
--   Os webhooks continuam entrando na fila do Redis e sao processados quando o
--   backend voltar — a janela nao perde mensagem.
--
-- FASE C — com o backend PARADO, derrubar o(s) unique(s) antigo(s):
--   os tres statements da secao "DROPS" no corpo deste arquivo (sao rapidos:
--   DROP INDEX de indice ja existente nao reescreve tabela).
--
-- FASE D — subir o backend NOVO (imagem ja com o schema.prisma novo):
--     docker compose up -d crm-backend
--   Conferir no log que o backend subiu e a fila drenou.
--
-- O corpo abaixo continua idempotente statement a statement, entao o apply
-- script pode executa-lo; mas so nas fases certas, com o backend parado.
-- ===========================================================================

BEGIN;

-- ── FASE A (variante COM lock, para banco pequeno/janela de manutencao) ─────
-- Em producao prefira a forma CONCURRENTLY do cabecalho: este CREATE bloqueia
-- ESCRITA na Message enquanto constroi, e a tabela tem milhoes de linhas.
CREATE UNIQUE INDEX IF NOT EXISTS "Message_tenant_id_whatsapp_message_id_lead_id_key"
  ON "Message"("tenant_id", "whatsapp_message_id", "lead_id");

-- ── DROPS (FASE C — exigem o backend PARADO) ────────────────────────────────
-- O objeto antigo e um UNIQUE INDEX puro em producao, mas um banco nascido de
-- migration teria uma CONSTRAINT com indice de apoio. Trata os dois casos, com
-- a constraint PRIMEIRO: `DROP INDEX` num indice que apoia constraint nao e
-- no-op, ele ERRA. Com a constraint fora, o DROP INDEX vira no-op e a mesma
-- SQL serve para os dois formatos, sempre idempotente.
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
  -- Legado do 0001_init: unique GLOBAL por wamid (sem tenant). Nao existe no
  -- banco atual; so aparece em ambiente restaurado de backup antigo. Se
  -- sobrevivesse, barraria a copia do segundo chat exatamente como o outro.
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Message_whatsapp_message_id_key'
      AND conrelid = '"Message"'::regclass
  ) THEN
    ALTER TABLE "Message" DROP CONSTRAINT "Message_whatsapp_message_id_key";
  END IF;
END
$$;

DROP INDEX IF EXISTS "Message_tenant_id_whatsapp_message_id_key";

DROP INDEX IF EXISTS "Message_whatsapp_message_id_key";

-- @@index([whatsapp_message_id]) (o NAO-unico, "Message_whatsapp_message_id_idx")
-- NAO e tocado: continua sendo o lookup do ack por wamid sozinho, a query mais
-- chamada do sistema.

COMMIT;

-- Validacao pos-apply (o novo tem que existir E os antigos terem sumido):
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'Message' AND indexname LIKE '%whatsapp_message_id%';
-- Esperado: Message_tenant_id_whatsapp_message_id_lead_id_key e
--           Message_whatsapp_message_id_idx. Nada mais.
