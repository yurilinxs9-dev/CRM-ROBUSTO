require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const env = fs.readFileSync(require('path').join(__dirname, '../.env'), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const q = (s, ...a) => p.$queryRawUnsafe(s, ...a);
const CAJURU = 'bb4953ac-b37f-4445-81c0-f54508c77141';
(async () => {
  const nn = await q(`SELECT count(*)::int n FROM "Lead" WHERE lead_scope IS NULL`);
  console.log('Leads lead_scope NULL (deve ser 0):', nn[0].n);
  const since = await q(`SELECT l.nome,l.lead_scope,l.instancia_whatsapp,i.owner_user_id,(l.lead_scope=i.owner_user_id) AS scope_ok
    FROM "Lead" l LEFT JOIN "WhatsappInstance" i ON i.nome=l.instancia_whatsapp AND i.tenant_id=l.tenant_id
    WHERE l.tenant_id=$1 AND l.created_at > now()-interval '40 min' ORDER BY l.created_at DESC LIMIT 10`, CAJURU);
  console.log('Leads criados últimos 40min (scope deve = owner da instância):');
  since.forEach((r) => console.log(`  ${r.nome} scope=${r.lead_scope?.slice(0,8)} owner=${r.owner_user_id?.slice(0,8)} ok=${r.scope_ok}`));
  const upd = await q(`SELECT nome,lead_scope,instancia_whatsapp,updated_at FROM "Lead" WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 5`, CAJURU);
  console.log('Últimos atualizados:');
  upd.forEach((r) => console.log(`  ${r.nome} scope=${r.lead_scope?.slice(0,8)} ${r.updated_at?.toISOString?.()}`));
  await p.$disconnect();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
