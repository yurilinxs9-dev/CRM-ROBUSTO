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

  // 3. FKs — NOT VALID para não varrer a tabela; validadas depois.
  //    O banco tem drift pré-existente em FKs de Lead; por isso cada uma vai
  //    isolada num DO block que ignora "já existe".
  const fks = [
    `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_lead_id_fkey"
       FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE`,
    `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_responsavel_id_fkey"
       FOREIGN KEY ("responsavel_id") REFERENCES "User"("id")`,
    `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenant_id_fkey"
       FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")`,
  ];
  for (const sql of fks) {
    await x(`DO $$ BEGIN ${sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  }
  console.log('FKs de Conversation OK');

  // 4. Message.conversation_id — NULLABLE nesta fase (Fase C aperta pra NOT NULL)
  await x(`ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "conversation_id" text`);
  await x(`CREATE INDEX IF NOT EXISTS "Message_conversation_id_created_at_idx"
    ON "Message"("conversation_id", "created_at")`);
  await x(`DO $$ BEGIN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id");
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  console.log('Message.conversation_id OK');

  // 5. verificação final
  const cols = await q(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Conversation' ORDER BY ordinal_position`);
  console.log('colunas de Conversation:', cols.map((c) => c.column_name).join(', '));
  const msgCol = await q(`SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'Message' AND column_name = 'conversation_id'`);
  console.log('Message.conversation_id:', JSON.stringify(msgCol));
  console.log('FASE A OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
