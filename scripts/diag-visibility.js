require('dotenv').config({ path: __dirname + '/../apps/api/.env' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const T = 'bb4953ac-b37f-4445-81c0-f54508c77141';
const SUPER = 'c554eeff-05ab-46fb-bb6a-4252fe532d00';

(async () => {
  const users = await p.user.findMany({ where: { tenant_id: T }, select: { id: true, nome: true, email: true, role: true, ativo: true } });
  console.log('== USERS =='); users.forEach(u => console.log(JSON.stringify(u)));

  const total = await p.lead.count({ where: { tenant_id: T } });
  const priv = await p.lead.count({ where: { tenant_id: T, is_private: true } });
  const semResp = await p.lead.count({ where: { tenant_id: T, responsavel_id: null } });
  console.log(`\n== LEADS total=${total} is_private=${priv} sem_responsavel=${semResp} ==`);

  // O que o SUPER_ADMIN enxerga na lista: is_private=false OR responsavel=self
  const superVe = await p.lead.count({ where: { tenant_id: T, OR: [{ is_private: false }, { responsavel_id: SUPER }] } });
  console.log(`super_admin enxerga na lista: ${superVe} de ${total} (ocultos=${total - superVe})`);

  // is_private por responsavel (quem privatizou)
  const byResp = await p.lead.groupBy({ by: ['responsavel_id', 'is_private'], where: { tenant_id: T }, _count: true });
  console.log('\n== leads por responsavel x is_private ==');
  const nameById = Object.fromEntries(users.map(u => [u.id, u.role + ':' + (u.nome || u.email)]));
  byResp.forEach(r => console.log(`${nameById[r.responsavel_id] || r.responsavel_id} is_private=${r.is_private} => ${r._count}`));

  // leads ocultos do super (is_private=true e nao dele)
  const ocultos = await p.lead.findMany({ where: { tenant_id: T, is_private: true, NOT: { responsavel_id: SUPER } }, select: { nome: true, responsavel_id: true }, take: 10 });
  console.log('\n== amostra leads OCULTOS do super_admin =='); ocultos.forEach(o => console.log(JSON.stringify({ nome: o.nome, resp: nameById[o.responsavel_id] })));

  await p.$disconnect();
})().catch(e => { console.error('ERR', e); process.exit(1); });
