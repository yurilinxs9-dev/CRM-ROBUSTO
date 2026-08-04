// Follow-up: coluna error_code em BroadcastTarget (motivo da falha como código).
// Aditiva, nullable e idempotente — pode rodar mais de uma vez.
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

(async () => {
  await p.$executeRawUnsafe(`SET statement_timeout = '15min'`);
  await p.$executeRawUnsafe(`ALTER TABLE "BroadcastTarget" ADD COLUMN IF NOT EXISTS "error_code" text`);

  const cols = await p.$queryRawUnsafe(`SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'BroadcastTarget' AND column_name IN ('error', 'error_code')
    ORDER BY column_name`);
  cols.forEach((c) => console.log(` ${c.column_name} | ${c.data_type} | nullable=${c.is_nullable}`));

  // Linhas antigas ficam com error_code nulo de propósito: reclassificar texto
  // cru retroativamente inventaria precisão que o dado não tem. O painel lê o
  // texto livre nesses casos (aggregateFailureReasons).
  const antigos = await p.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "BroadcastTarget" WHERE status = 'failed' AND error_code IS NULL`,
  );
  console.log(`alvos falhados sem código (histórico): ${antigos[0].n}`);
  console.log('OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
