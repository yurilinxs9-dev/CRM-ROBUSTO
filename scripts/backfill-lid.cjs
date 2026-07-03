/* eslint-disable */
// Backfill Lead.whatsapp_lid a partir do mapa PN→lid extraído do banco da
// Evolution (lid-map.json: [{inst, lid, pn}]). Roda dentro do crm-backend.
// Uso: node backfill-lid.cjs /app/lid-map.json
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const rows = JSON.parse(fs.readFileSync(process.argv[2] || '/app/lid-map.json', 'utf8'));
  // instância → tenant
  const instances = await p.whatsappInstance.findMany({ select: { nome: true, tenant_id: true } });
  const tenantByInst = Object.fromEntries(instances.map(i => [i.nome, i.tenant_id]));

  // dedup: por (tenant, telefone) fica o último lid visto
  const map = new Map();
  for (const r of rows) {
    const tenant = tenantByInst[r.inst];
    if (!tenant || !r.lid || !r.pn) continue;
    const digits = String(r.pn).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 13) continue;
    map.set(`${tenant}|${digits}`, { tenant, digits, lid: r.lid });
  }
  console.log(`mapa: ${rows.length} linhas → ${map.size} pares únicos tenant+telefone`);

  // SQL cru: o client Prisma do container pode ser anterior à coluna.
  let updated = 0, misses = 0;
  for (const { tenant, digits, lid } of map.values()) {
    const res = await p.$executeRawUnsafe(
      'UPDATE "Lead" SET whatsapp_lid=$1 WHERE tenant_id=$2 AND telefone=$3', lid, tenant, digits);
    if (res > 0) updated += res; else misses++;
  }
  console.log(`leads atualizados: ${updated}; pares sem lead: ${misses}`);
  const withLid = await p.$queryRawUnsafe('SELECT count(*) c FROM "Lead" WHERE whatsapp_lid IS NOT NULL');
  console.log(`total leads com whatsapp_lid: ${Number(withLid[0].c)}`);
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
