require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const VT = '940f733d-0563-4589-a72e-afbbdff3098d'; // virtualteste

(async () => {
  // mensagens do tenant virtualteste
  const msgs = await p.message.findMany({
    where: { tenant_id: VT },
    select: { id: true, lead_id: true, instance_name: true, direction: true, content: true, created_at: true },
    orderBy: { created_at: 'desc' }, take: 30,
  });
  console.log('=== mensagens tenant virtualteste:', msgs.length, '===');
  msgs.forEach((m) => console.log('  ', m.direction, '| inst=', m.instance_name, '|', (m.content || '').slice(0, 40)));

  // leads/mensagens em OUTROS tenants apontando pra instância 'teste-virtual' (vazamento de escrita)
  const crossLeads = await p.lead.count({ where: { instancia_whatsapp: 'teste-virtual', tenant_id: { not: VT } } });
  const crossMsgs = await p.message.count({ where: { instance_name: 'teste-virtual', tenant_id: { not: VT } } });
  console.log('\nleads de OUTRO tenant com instancia=teste-virtual:', crossLeads);
  console.log('mensagens de OUTRO tenant com instance_name=teste-virtual:', crossMsgs);

  // instâncias com nome 'teste' (a colisão) — quais tenants/tokens
  const testeInst = await p.whatsappInstance.findMany({ where: { nome: 'teste' }, select: { id: true, tenant_id: true, status: true, config: true } });
  console.log('\n=== instâncias nome="teste" (colisão) ===');
  testeInst.forEach((i) => console.log('  tenant=', i.tenant_id, 'status=', i.status, 'tok=', i.config && i.config.uazapi_token ? String(i.config.uazapi_token).slice(0, 8) + '…' : null));

  // mensagens/leads do tenant virtualteste com instance_name DIFERENTE de teste-virtual (sinal de mistura)
  const foreignInst = await p.message.groupBy({ by: ['instance_name'], where: { tenant_id: VT }, _count: { id: true } });
  console.log('\n=== instance_name das msgs de virtualteste (deve ser só teste-virtual) ===');
  foreignInst.forEach((g) => console.log('  ', g.instance_name, '→', g._count.id));

  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
