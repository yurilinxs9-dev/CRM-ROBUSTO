require('dotenv').config({ path: __dirname + '/../apps/api/.env' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const T = 'bb4953ac-b37f-4445-81c0-f54508c77141';

(async () => {
  // group messages by lead + instance_name
  const g = await p.message.groupBy({
    by: ['lead_id', 'instance_name'],
    where: { tenant_id: T },
    _count: true,
  });
  const byLead = {};
  for (const r of g) {
    if (!r.instance_name) continue;
    (byLead[r.lead_id] ||= {})[r.instance_name] = r._count;
  }
  const collided = Object.entries(byLead).filter(([, m]) => Object.keys(m).length > 1);
  console.log('TOTAL leads colididos (msgs de >1 instancia):', collided.length, 'de', Object.keys(byLead).length, 'leads c/ msgs');

  collided.sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length);
  for (const [leadId, m] of collided.slice(0, 20)) {
    const lead = await p.lead.findUnique({ where: { id: leadId }, select: { nome: true, telefone: true, instancia_whatsapp: true } });
    console.log(JSON.stringify({ tel: lead?.telefone, nome: lead?.nome, lead_instancia: lead?.instancia_whatsapp, instances: m }));
  }

  // distribution per instance x direction
  const dist = await p.message.groupBy({ by: ['instance_name', 'direction'], where: { tenant_id: T }, _count: true });
  console.log('\n== MSGS por instancia x direcao ==');
  dist.forEach(d => console.log(`${d.instance_name} ${d.direction} = ${d._count}`));

  await p.$disconnect();
})().catch(e => { console.error('ERR', e); process.exit(1); });
