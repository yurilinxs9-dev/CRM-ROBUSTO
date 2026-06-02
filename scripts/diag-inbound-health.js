require('dotenv').config({ path: __dirname + '/../apps/api/.env' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const T = 'bb4953ac-b37f-4445-81c0-f54508c77141';
const h = (n) => new Date(Date.now() - n * 3600 * 1000);
const ago = (d) => d ? Math.round((Date.now() - new Date(d)) / 60000) + 'min' : 'nunca';

(async () => {
  const insts = await p.whatsappInstance.findMany({ where: { tenant_id: T }, select: { nome: true, status: true, ultimo_check: true } });
  console.log('== INSTANCIAS: status / ultimo_check / ultimo INCOMING / IN 24h / IN 48h ==');
  for (const i of insts) {
    const last = await p.message.findFirst({ where: { tenant_id: T, instance_name: i.nome, direction: 'INCOMING' }, orderBy: { created_at: 'desc' }, select: { created_at: true } });
    const in24 = await p.message.count({ where: { tenant_id: T, instance_name: i.nome, direction: 'INCOMING', created_at: { gte: h(24) } } });
    const in48 = await p.message.count({ where: { tenant_id: T, instance_name: i.nome, direction: 'INCOMING', created_at: { gte: h(48) } } });
    const flag = last && (Date.now() - new Date(last.created_at)) > 6 * 3600 * 1000 ? '  <-- SEM ENTRADA >6h' : '';
    console.log(`${i.nome.padEnd(18)} ${String(i.status).padEnd(6)} chk:${ago(i.ultimo_check).padEnd(10)} in:${ago(last?.created_at).padEnd(10)} 24h=${in24} 48h=${in48}${flag}`);
  }

  // webhook entrantes vs mensagens persistidas (detecta drops)
  const whIn = await p.webhookLog.count({ where: { tenant_id: T, event: { in: ['uazapi.messages', 'uazapi.message'] }, created_at: { gte: h(24) } } });
  const msgIn24 = await p.message.count({ where: { tenant_id: T, direction: 'INCOMING', created_at: { gte: h(24) } } });
  const msgOut24 = await p.message.count({ where: { tenant_id: T, direction: 'OUTGOING', created_at: { gte: h(24) } } });
  console.log(`\n== 24h: webhookLog(uazapi.messages)=${whIn}  msgs INCOMING=${msgIn24}  OUTGOING=${msgOut24} ==`);
  console.log('(webhookLog conta evento bruto; 1 evento pode trazer >1 msg ou ser fromMe — diferença pequena = normal)');

  // erros / não processados 48h (toda a plataforma p/ pegar token não resolvido)
  const errs = await p.webhookLog.count({ where: { created_at: { gte: h(48) }, NOT: { error: null } } });
  const unproc = await p.webhookLog.count({ where: { created_at: { gte: h(48) }, processed: false } });
  const nullTen = await p.webhookLog.count({ where: { created_at: { gte: h(48) }, tenant_id: null } });
  console.log(`\n== webhookLog 48h (plataforma): erros=${errs} nao_processados=${unproc} tenant_nulo=${nullTen} ==`);
  if (errs > 0) {
    const sample = await p.webhookLog.findMany({ where: { created_at: { gte: h(48) }, NOT: { error: null } }, take: 5, orderBy: { created_at: 'desc' }, select: { event: true, instance: true, error: true, created_at: true } });
    sample.forEach(s => console.log('  ERR', s.event, s.instance, String(s.error).slice(0, 140)));
  }

  // leads com unread alto (operador talvez não está vendo)
  const topUnread = await p.lead.findMany({ where: { tenant_id: T, mensagens_nao_lidas: { gt: 0 } }, orderBy: { mensagens_nao_lidas: 'desc' }, take: 8, select: { nome: true, telefone: true, mensagens_nao_lidas: true, instancia_whatsapp: true, ultima_interacao: true } });
  console.log(`\n== TOP leads nao-lidos ==`);
  topUnread.forEach(l => console.log(`${l.mensagens_nao_lidas}x ${l.nome} (${l.instancia_whatsapp}) ${ago(l.ultima_interacao)}`));

  await p.$disconnect();
})().catch(e => { console.error('ERR', e); process.exit(1); });
