require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // 1. tenant virtualteste
  const u = await p.user.findUnique({ where: { email: 'virtualteste@gmail.com' }, select: { id: true, tenant_id: true, nome: true } });
  console.log('=== virtualteste ===', u);
  const tid = u?.tenant_id;

  if (tid) {
    const insts = await p.whatsappInstance.findMany({ where: { tenant_id: tid }, select: { id: true, nome: true, status: true, owner_user_id: true, config: true } });
    console.log('instâncias do tenant:', insts.map((i) => ({ nome: i.nome, status: i.status, tok: (i.config && i.config.uazapi_token) ? String(i.config.uazapi_token).slice(0, 8) + '…' : null })));
    const leads = await p.lead.count({ where: { tenant_id: tid } });
    console.log('leads no tenant virtualteste:', leads);
    // leads cujo instancia_whatsapp NÃO é instância desse tenant (vazamento)
    const tenantInstNames = new Set(insts.map((i) => i.nome));
    const sampleLeads = await p.lead.findMany({ where: { tenant_id: tid }, select: { id: true, nome: true, telefone: true, instancia_whatsapp: true, created_at: true }, orderBy: { created_at: 'desc' }, take: 15 });
    console.log('amostra leads virtualteste:');
    sampleLeads.forEach((l) => console.log('  ', l.nome, '|', l.telefone, '| inst=', l.instancia_whatsapp, (tenantInstNames.has(l.instancia_whatsapp) ? '' : '⚠️ INST DE OUTRO TENANT')));
  }

  // 2. colisão de nome de instância entre tenants
  const dupInst = await p.$queryRawUnsafe(`
    SELECT nome, count(DISTINCT tenant_id)::int AS tenants, count(*)::int AS total
    FROM "WhatsappInstance" GROUP BY nome HAVING count(DISTINCT tenant_id) > 1 ORDER BY tenants DESC LIMIT 20`);
  console.log('\n=== nomes de instância usados por VÁRIOS tenants (colisão) ===');
  dupInst.forEach((r) => console.log('  nome=', JSON.stringify(r.nome), 'tenants=', r.tenants, 'total=', r.total));

  // 3. tokens uazapi duplicados entre instâncias/tenants (token compartilhado = vazamento direto)
  const dupTok = await p.$queryRawUnsafe(`
    SELECT config->>'uazapi_token' AS tok, count(*)::int AS n, count(DISTINCT tenant_id)::int AS tenants
    FROM "WhatsappInstance" WHERE config->>'uazapi_token' IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1 ORDER BY n DESC LIMIT 20`);
  console.log('\n=== uazapi_token usado por VÁRIAS instâncias (CRÍTICO se entre tenants) ===');
  dupTok.forEach((r) => console.log('  tok=', String(r.tok).slice(0, 10) + '…', 'instâncias=', r.n, 'tenants=', r.tenants));

  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
