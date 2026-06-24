// FASE 1c: backfill NULLs da janela + NOT NULL + dropa índice unique velho.
// Rodar SÓ depois do código novo estar live (já seta lead_scope).
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const env = fs.readFileSync(require('path').join(__dirname, '../.env'), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() || env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

(async () => {
  // 1. backfill quaisquer NULLs criados na janela (código velho não setava)
  await x(`UPDATE "Lead" l SET lead_scope = l.tenant_id FROM "Tenant" t WHERE t.id=l.tenant_id AND t.pool_enabled=true AND l.lead_scope IS NULL`);
  await x(`UPDATE "Lead" l SET lead_scope = i.owner_user_id FROM "WhatsappInstance" i, "Tenant" t WHERE i.nome=l.instancia_whatsapp AND i.tenant_id=l.tenant_id AND t.id=l.tenant_id AND t.pool_enabled=false AND l.lead_scope IS NULL`);
  await x(`UPDATE "Lead" SET lead_scope = responsavel_id WHERE lead_scope IS NULL AND responsavel_id IS NOT NULL`);
  await x(`UPDATE "Lead" SET lead_scope = tenant_id WHERE lead_scope IS NULL`);
  const nulls = await q(`SELECT count(*)::int n FROM "Lead" WHERE lead_scope IS NULL`);
  console.log('NULLs após backfill janela:', nulls[0].n);
  if (nulls[0].n > 0) { console.error('ABORT: ainda há NULL'); process.exit(1); }

  // 2. NOT NULL
  await x(`ALTER TABLE "Lead" ALTER COLUMN "lead_scope" SET NOT NULL`);
  console.log('lead_scope SET NOT NULL');

  // 3. dropa índice unique velho (telefone,pipeline) — libera lead por número
  await x(`DROP INDEX IF EXISTS "Lead_telefone_pipeline_id_key"`);
  console.log('índice velho Lead_telefone_pipeline_id_key dropado');

  // 4. verificação
  const idx = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='Lead' AND indexname LIKE 'Lead_telefone%'`);
  console.log('índices telefone restantes:');
  idx.forEach((i) => console.log('  ', i.indexname));
  const col = await q(`SELECT is_nullable FROM information_schema.columns WHERE table_name='Lead' AND column_name='lead_scope'`);
  console.log('lead_scope is_nullable:', col[0].is_nullable);
  console.log('FASE 1c OK');
  await p.$disconnect();
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
