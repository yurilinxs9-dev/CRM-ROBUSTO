require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const env = fs.readFileSync(require('path').join(__dirname, '../.env'), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const q = (s, ...a) => p.$queryRawUnsafe(s, ...a);
const CAJURU = 'bb4953ac-b37f-4445-81c0-f54508c77141';
(async () => {
  // 1. leads ainda colididos (msgs de >1 dono de instância CONHECIDA)
  const coll = await q(`
    SELECT count(*)::int n FROM (
      SELECT l.id FROM "Lead" l JOIN "Message" m ON m.lead_id=l.id
      JOIN "WhatsappInstance" i ON i.nome=m.instance_name AND i.tenant_id=l.tenant_id
      WHERE l.tenant_id=$1 GROUP BY l.id
      HAVING count(DISTINCT i.owner_user_id)>1) t`, CAJURU);
  console.log('Leads ainda colididos (>1 dono conhecido):', coll[0].n, '(esperado 0)');

  // 2. lead_scope sempre = dono da instância das suas msgs conhecidas? (consistência)
  const incons = await q(`
    SELECT count(*)::int n FROM (
      SELECT l.id FROM "Lead" l JOIN "Message" m ON m.lead_id=l.id
      JOIN "WhatsappInstance" i ON i.nome=m.instance_name AND i.tenant_id=l.tenant_id
      WHERE l.tenant_id=$1 AND i.owner_user_id <> l.lead_scope
      GROUP BY l.id) t`, CAJURU);
  console.log('Leads com msg de dono != lead_scope (resto de instância desconhecida ok):', incons[0].n);

  // 3. total de mensagens do tenant (conservação — comparar com antes não temos, mas checa órfãs)
  const orf = await q(`SELECT count(*)::int n FROM "Message" m LEFT JOIN "Lead" l ON l.id=m.lead_id WHERE l.id IS NULL`);
  console.log('Mensagens órfãs (lead inexistente):', orf[0].n, '(esperado 0)');

  // 4. NULL scope
  const nn = await q(`SELECT count(*)::int n FROM "Lead" WHERE lead_scope IS NULL`);
  console.log('Leads lead_scope NULL:', nn[0].n, '(esperado 0)');

  // 5. contagem de leads do tenant
  const tot = await q(`SELECT count(*)::int n FROM "Lead" WHERE tenant_id=$1`, CAJURU);
  console.log('Total leads Cajuru agora:', tot[0].n, '(era 883)');

  // 6. unique index correto
  const idx = await q(`SELECT indexname FROM pg_indexes WHERE tablename='Lead' AND indexname LIKE 'Lead_telefone%'`);
  console.log('Índices telefone:', idx.map((i) => i.indexname).join(', '));

  // 7. amostra: Eli phone agora separado por operador
  const eli = await q(`SELECT lead_scope,responsavel_id,(SELECT count(*)::int FROM "Message" WHERE lead_id="Lead".id) msgs
    FROM "Lead" WHERE telefone='553799581960' AND tenant_id=$1 ORDER BY msgs DESC`, CAJURU);
  console.log('Eli telefone — leads por operador:', eli.map((e) => `${e.lead_scope?.slice(0,8)}:${e.msgs}`).join(', '));
  await p.$disconnect();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
