// READ-ONLY. Estado real antes da migration lead_scope.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const env = fs.readFileSync(require('path').join(__dirname, '../.env'), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() || env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const q = (sql, ...a) => p.$queryRawUnsafe(sql, ...a);

const CAJURU = 'bb4953ac-b37f-4445-81c0-f54508c77141';

(async () => {
  // 1. Constraint atual em Lead
  const cons = await q(`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid='"Lead"'::regclass AND contype IN ('u','p')`);
  console.log('=== UNIQUE/PK em Lead ===');
  cons.forEach((c) => console.log(`  ${c.conname}: ${c.def}`));

  // coluna lead_scope já existe?
  const col = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='Lead' AND column_name='lead_scope'`);
  console.log('lead_scope column exists:', col.length > 0);

  // 2. Cajuru: modo + pipelines + instâncias(owner)
  const t = await q(`SELECT pool_enabled, round_robin_enabled FROM "Tenant" WHERE id=$1`, CAJURU);
  console.log('\n=== Cajuru ===', JSON.stringify(t[0]));
  const insts = await q(`SELECT i.nome, i.owner_user_id, u.nome AS owner_nome, u.role
    FROM "WhatsappInstance" i LEFT JOIN "User" u ON u.id=i.owner_user_id
    WHERE i.tenant_id=$1 ORDER BY i.nome`, CAJURU);
  console.log('Instâncias:'); insts.forEach((i) => console.log(`  ${i.nome} -> owner=${i.owner_nome}(${i.role}) ${i.owner_user_id}`));
  const pipes = await q(`SELECT id, nome FROM "Pipeline" WHERE tenant_id=$1`, CAJURU);
  console.log('Pipelines:', pipes.map((x) => `${x.nome}(${x.id})`).join(', '));

  // 3. Leads colididos: mensagens de >1 dono-de-instância no mesmo lead
  const collided = await q(`
    SELECT l.id, l.nome, l.telefone, l.responsavel_id,
           ru.nome AS resp_nome,
           count(DISTINCT i.owner_user_id)::int AS distinct_owners,
           array_agg(DISTINCT i.owner_user_id) AS owners,
           count(m.id)::int AS msgs
    FROM "Lead" l
    JOIN "Message" m ON m.lead_id=l.id
    JOIN "WhatsappInstance" i ON i.nome=m.instance_name
    LEFT JOIN "User" ru ON ru.id=l.responsavel_id
    WHERE l.tenant_id=$1
    GROUP BY l.id, l.nome, l.telefone, l.responsavel_id, ru.nome
    HAVING count(DISTINCT i.owner_user_id) > 1
    ORDER BY distinct_owners DESC, msgs DESC`, CAJURU);
  console.log(`\n=== Leads COLIDIDOS (msgs de >1 dono de número): ${collided.length} ===`);
  collided.slice(0, 20).forEach((l) =>
    console.log(`  ${l.nome} (${l.telefone}) resp=${l.resp_nome} owners=${l.distinct_owners} msgs=${l.msgs} id=${l.id}`));

  // total leads tenant
  const tot = await q(`SELECT count(*)::int n FROM "Lead" WHERE tenant_id=$1`, CAJURU);
  console.log(`\nTotal leads Cajuru: ${tot[0].n}`);

  // 4. Lead do Eli especificamente
  const eli = await q(`
    SELECT l.id, l.nome, l.telefone, l.responsavel_id, ru.nome AS resp
    FROM "Lead" l LEFT JOIN "User" ru ON ru.id=l.responsavel_id
    WHERE l.tenant_id=$1 AND l.nome ILIKE '%eli%'`, CAJURU);
  console.log('\n=== Lead(s) "Eli" ===');
  for (const e of eli) {
    console.log(`  ${e.nome} (${e.telefone}) resp=${e.resp} id=${e.id}`);
    const byOwner = await q(`
      SELECT i.owner_user_id, u.nome AS owner, i.nome AS instancia, count(*)::int n,
             min(m.created_at) AS primeira, max(m.created_at) AS ultima
      FROM "Message" m JOIN "WhatsappInstance" i ON i.nome=m.instance_name
      LEFT JOIN "User" u ON u.id=i.owner_user_id
      WHERE m.lead_id=$1 GROUP BY i.owner_user_id, u.nome, i.nome ORDER BY n DESC`, e.id);
    byOwner.forEach((b) => console.log(`     via ${b.instancia} (dono ${b.owner}): ${b.n} msgs  ${b.primeira?.toISOString?.()||b.primeira} .. ${b.ultima?.toISOString?.()||b.ultima}`));
  }
  await p.$disconnect();
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
