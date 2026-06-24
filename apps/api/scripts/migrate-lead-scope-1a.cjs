// FASE 1a (aditivo, reversível): add coluna lead_scope + backfill + índice unique novo.
// NÃO dropa o índice velho ainda (código velho continua funcionando).
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const env = fs.readFileSync(require('path').join(__dirname, '../.env'), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() || env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

(async () => {
  // 0. pré-checagem: garante que (telefone,pipeline_id) é único hoje (precondição)
  const dup = await q(`SELECT count(*)::int n FROM (SELECT telefone,pipeline_id FROM "Lead" GROUP BY 1,2 HAVING count(*)>1) t`);
  if (dup[0].n > 0) { console.error('ABORT: existem', dup[0].n, 'grupos telefone+pipeline duplicados — investigar antes.'); process.exit(1); }
  console.log('precheck OK: 0 duplicatas telefone+pipeline');

  // 1. add coluna nullable (instantâneo)
  await x(`ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "lead_scope" text`);
  console.log('coluna lead_scope adicionada (nullable)');

  // 2. backfill
  // pool tenants -> tenant_id
  const a = await x(`UPDATE "Lead" l SET lead_scope = l.tenant_id
    FROM "Tenant" t WHERE t.id=l.tenant_id AND t.pool_enabled=true AND l.lead_scope IS NULL`);
  // individual -> owner da instância (nome+tenant)
  const b = await x(`UPDATE "Lead" l SET lead_scope = i.owner_user_id
    FROM "WhatsappInstance" i, "Tenant" t
    WHERE i.nome=l.instancia_whatsapp AND i.tenant_id=l.tenant_id
      AND t.id=l.tenant_id AND t.pool_enabled=false AND l.lead_scope IS NULL`);
  // fallback responsavel
  const c = await x(`UPDATE "Lead" SET lead_scope = responsavel_id WHERE lead_scope IS NULL AND responsavel_id IS NOT NULL`);
  // fallback tenant
  const d = await x(`UPDATE "Lead" SET lead_scope = tenant_id WHERE lead_scope IS NULL`);
  console.log(`backfill: pool=${a} individual=${b} fb_resp=${c} fb_tenant=${d}`);

  const nulls = await q(`SELECT count(*)::int n FROM "Lead" WHERE lead_scope IS NULL`);
  if (nulls[0].n > 0) { console.error('ABORT: ainda há', nulls[0].n, 'leads com lead_scope NULL'); process.exit(1); }
  console.log('0 NULLs restantes');

  // 3. checa que (telefone,pipeline,scope) é único antes de criar índice unique
  const dup2 = await q(`SELECT count(*)::int n FROM (SELECT telefone,pipeline_id,lead_scope FROM "Lead" GROUP BY 1,2,3 HAVING count(*)>1) t`);
  if (dup2[0].n > 0) { console.error('ABORT:', dup2[0].n, 'grupos telefone+pipeline+scope duplicados'); process.exit(1); }

  // 4. cria índice unique novo (coexiste com o velho)
  await x(`CREATE UNIQUE INDEX IF NOT EXISTS "Lead_telefone_pipeline_scope_key" ON "Lead"(telefone, pipeline_id, lead_scope)`);
  console.log('índice Lead_telefone_pipeline_scope_key criado');

  // verificação final
  const idx = await q(`SELECT indexname FROM pg_indexes WHERE tablename='Lead' AND indexname IN ('Lead_telefone_pipeline_id_key','Lead_telefone_pipeline_scope_key')`);
  console.log('índices presentes:', idx.map((i) => i.indexname).join(', '));
  console.log('FASE 1a OK');
  await p.$disconnect();
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
