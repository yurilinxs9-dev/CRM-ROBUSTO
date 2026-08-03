// FASE A (aditivo, reversível): cria a tabela Conversation e a coluna
// Message.conversation_id (NULLABLE). Não faz backfill — isso é a Fase B.
// Idempotente: pode rodar mais de uma vez sem estragar nada.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const url =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

(async () => {
  // 0. precondição: o enum ConversationStatus já existe (usado por Lead.atendimento_status)
  const enumRows = await q(
    `SELECT 1 FROM pg_type WHERE typname = 'ConversationStatus'`,
  );
  if (enumRows.length === 0) {
    console.error('ABORT: enum ConversationStatus não existe no banco.');
    process.exit(1);
  }
  console.log('precheck OK: enum ConversationStatus presente');

  // 1. tabela Conversation
  await x(`CREATE TABLE IF NOT EXISTS "Conversation" (
    "id" text PRIMARY KEY,
    "lead_id" text NOT NULL,
    "instancia_whatsapp" text NOT NULL,
    "responsavel_id" text,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "last_customer_message_at" timestamp(3),
    "last_message_at" timestamp(3),
    "assumed_at" timestamp(3),
    "ai_blocked" boolean NOT NULL DEFAULT false,
    "tenant_id" text NOT NULL,
    "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('tabela Conversation criada/já existia');

  // 2. índices
  await x(`CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_lead_id_instancia_whatsapp_key"
    ON "Conversation"("lead_id", "instancia_whatsapp")`);
  await x(`CREATE INDEX IF NOT EXISTS "Conversation_tenant_id_responsavel_id_idx"
    ON "Conversation"("tenant_id", "responsavel_id")`);
  await x(`CREATE INDEX IF NOT EXISTS "Conversation_lead_id_last_customer_message_at_idx"
    ON "Conversation"("lead_id", "last_customer_message_at")`);
  console.log('índices de Conversation OK');

  // 3. FKs, com as mesmas ações ON DELETE/ON UPDATE que o Prisma infere do
  //    schema (Conversation.lead_id obrigatório+cascade explícito;
  //    responsavel_id opcional → SET NULL; tenant_id obrigatório → RESTRICT;
  //    todas ON UPDATE CASCADE, que é o default do Prisma).
  //    Repara (drop+recria) em vez de "cria se não existir": rodar isto de
  //    novo numa base onde a constraint já existe com as ações certas é
  //    inócuo (drop+recreate idêntico); numa base com ações erradas, corrige.
  //    APENAS estas 4 constraints (as 4 criadas por este script) — nenhuma
  //    outra tabela/constraint é tocada.
  const fks = [
    {
      name: 'Conversation_lead_id_fkey',
      sql: `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_lead_id_fkey"
       FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    },
    {
      name: 'Conversation_responsavel_id_fkey',
      sql: `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_responsavel_id_fkey"
       FOREIGN KEY ("responsavel_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    },
    {
      name: 'Conversation_tenant_id_fkey',
      sql: `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenant_id_fkey"
       FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    },
  ];
  for (const fk of fks) {
    await x(`ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "${fk.name}"`);
    await x(fk.sql);
  }
  console.log('FKs de Conversation OK (ações ON DELETE/ON UPDATE conferidas)');

  // 4. Message.conversation_id — NULLABLE nesta fase (Fase C aperta pra
  //    NOT NULL; quando isso acontecer, a FK abaixo deve virar
  //    ON DELETE RESTRICT — ver Task 8 do plano).
  await x(`ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "conversation_id" text`);
  await x(`CREATE INDEX IF NOT EXISTS "Message_conversation_id_created_at_idx"
    ON "Message"("conversation_id", "created_at")`);
  await x(`ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_conversation_id_fkey"`);
  await x(`ALTER TABLE "Message" ADD CONSTRAINT "Message_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id")
      ON DELETE SET NULL ON UPDATE CASCADE`);
  console.log('Message.conversation_id OK (ação ON DELETE/ON UPDATE conferida)');

  // 5. verificação final
  const cols = await q(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Conversation' ORDER BY ordinal_position`);
  console.log('colunas de Conversation:', cols.map((c) => c.column_name).join(', '));
  const msgCol = await q(`SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'Message' AND column_name = 'conversation_id'`);
  console.log('Message.conversation_id:', JSON.stringify(msgCol));

  // 6. verificação das ações das 4 FKs (confdeltype/confupdtype: a=NO ACTION,
  //    r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT)
  const fkActions = await q(`SELECT conname, confdeltype, confupdtype
    FROM pg_constraint
    WHERE conname IN (
      'Conversation_lead_id_fkey',
      'Conversation_responsavel_id_fkey',
      'Conversation_tenant_id_fkey',
      'Message_conversation_id_fkey'
    ) ORDER BY conname`);
  console.log('FK actions:', JSON.stringify(fkActions));

  console.log('FASE A OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
