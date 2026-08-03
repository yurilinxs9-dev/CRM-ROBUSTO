// Follow-up Etapa 1: valor de enum `replied`, coluna replied_at, índice por
// lead_id, e as três colunas de janela de horário no Tenant.
// Aditivo e idempotente — pode rodar mais de uma vez.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const baseUrl =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=300`;
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

(async () => {
  await x(`SET statement_timeout = '15min'`);

  // 1. Valor novo no enum. ADD VALUE IF NOT EXISTS é idempotente e, no
  //    Postgres 12+, não precisa rodar fora de transação.
  await x(`ALTER TYPE "BroadcastTargetStatus" ADD VALUE IF NOT EXISTS 'replied'`);
  const vals = await q(`
    SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) v
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BroadcastTargetStatus'`);
  console.log('BroadcastTargetStatus:', vals[0].v);

  // 2. Coluna replied_at.
  await x(`ALTER TABLE "BroadcastTarget" ADD COLUMN IF NOT EXISTS "replied_at" timestamp(3)`);

  // 3. Índice por lead_id — pré-requisito do gancho de resposta.
  await x(`CREATE INDEX IF NOT EXISTS "BroadcastTarget_lead_id_status_idx"
    ON "BroadcastTarget"("lead_id", "status")`);

  // 4. Janela de horário no Tenant.
  await x(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "broadcast_window_start" integer NOT NULL DEFAULT 9`);
  await x(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "broadcast_window_end" integer NOT NULL DEFAULT 18`);
  await x(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "broadcast_window_days" integer[] NOT NULL DEFAULT '{1,2,3,4,5}'`);

  // 5. Verificação.
  const cols = await q(`SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = 'Tenant' AND column_name LIKE 'broadcast_window%'
    ORDER BY column_name`);
  cols.forEach((c) => console.log(` ${c.column_name} | ${c.data_type} | ${c.column_default}`));
  const idx = await q(`SELECT indexname FROM pg_indexes
    WHERE tablename = 'BroadcastTarget' ORDER BY indexname`);
  console.log('índices:', idx.map((i) => i.indexname).join(', '));
  console.log('OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
