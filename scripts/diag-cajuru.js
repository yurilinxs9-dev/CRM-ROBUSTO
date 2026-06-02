require('dotenv').config({ path: __dirname + '/../apps/api/.env' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // 1. Locate tenant by user email or tenant name
  const user = await p.user.findFirst({
    where: { email: 'cajuruinteriores@gmail.com' },
    select: { id: true, tenant_id: true, nome: true, role: true, ativo: true },
  });
  let tenantId = user?.tenant_id;
  let tenant = tenantId
    ? await p.tenant.findUnique({ where: { id: tenantId } })
    : await p.tenant.findFirst({ where: { nome: { contains: 'Cajuru', mode: 'insensitive' } } });
  if (!tenant) { console.log('TENANT NOT FOUND'); return p.$disconnect(); }
  tenantId = tenant.id;
  console.log('== TENANT =='); console.log(JSON.stringify({ id: tenant.id, nome: tenant.nome, pool_enabled: tenant.pool_enabled }, null, 2));
  console.log('user:', JSON.stringify(user));

  // 2. Instances + status + token presence
  const insts = await p.whatsappInstance.findMany({ where: { tenant_id: tenantId } });
  console.log('\n== INSTANCES (' + insts.length + ') ==');
  for (const i of insts) {
    const cfg = i.config || {};
    console.log(JSON.stringify({
      id: i.id, nome: i.nome, status: i.status, ultimo_check: i.ultimo_check,
      owner_user_id: i.owner_user_id,
      has_uazapi_token: !!cfg.uazapi_token,
      token_tail: cfg.uazapi_token ? String(cfg.uazapi_token).slice(-6) : null,
    }));
  }

  // 3. Pipelines (multi-pipeline = lead hidden in wrong board)
  const pipes = await p.pipeline.findMany({ where: { tenant_id: tenantId }, orderBy: { created_at: 'asc' }, select: { id: true, nome: true, ativo: true, created_at: true } });
  console.log('\n== PIPELINES (' + pipes.length + ') ==');
  pipes.forEach(pp => console.log(JSON.stringify(pp)));
  const leadsPerPipe = await p.lead.groupBy({ by: ['pipeline_id'], where: { tenant_id: tenantId }, _count: true });
  console.log('leads por pipeline:', JSON.stringify(leadsPerPipe));

  // 4. Webhook logs — errors / unprocessed last 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const logs = await p.webhookLog.findMany({
    where: { tenant_id: tenantId, created_at: { gte: since } },
    orderBy: { created_at: 'desc' }, take: 200,
    select: { event: true, processed: true, error: true, created_at: true },
  });
  const byEvent = {};
  let errCount = 0, unproc = 0;
  for (const l of logs) {
    byEvent[l.event] = (byEvent[l.event] || 0) + 1;
    if (l.error) errCount++;
    if (!l.processed) unproc++;
  }
  console.log('\n== WEBHOOK LOGS 24h (tenant) total=' + logs.length + ' err=' + errCount + ' unprocessed=' + unproc + ' ==');
  console.log('por evento:', JSON.stringify(byEvent));
  const errs = logs.filter(l => l.error).slice(0, 8);
  errs.forEach(e => console.log('ERR', e.event, e.created_at, String(e.error).slice(0, 160)));

  // 4b. Webhook logs with NULL tenant (token/instance not resolved = inbound miss)
  const nullTenant = await p.webhookLog.count({ where: { tenant_id: null, created_at: { gte: since } } });
  console.log('webhookLog tenant_id=NULL 24h (toda plataforma):', nullTenant);

  // 5. Recent leads + messages
  const leadCount = await p.lead.count({ where: { tenant_id: tenantId } });
  const recentLeads = await p.lead.findMany({ where: { tenant_id: tenantId }, orderBy: { ultima_interacao: 'desc' }, take: 5, select: { nome: true, telefone: true, pipeline_id: true, ultima_interacao: true, mensagens_nao_lidas: true } });
  console.log('\n== LEADS total=' + leadCount + ' ==');
  recentLeads.forEach(l => console.log(JSON.stringify(l)));

  const msgFailed = await p.message.count({ where: { tenant_id: tenantId, status: 'FAILED' } });
  const msgPending = await p.message.count({ where: { tenant_id: tenantId, status: 'PENDING' } });
  const msg24 = await p.message.count({ where: { tenant_id: tenantId, created_at: { gte: since } } });
  console.log('\n== MESSAGES: 24h=' + msg24 + ' FAILED(all)=' + msgFailed + ' PENDING(all)=' + msgPending + ' ==');
  const recentFailed = await p.message.findMany({ where: { tenant_id: tenantId, status: 'FAILED' }, orderBy: { created_at: 'desc' }, take: 5, select: { direction: true, type: true, created_at: true, metadata: true } });
  recentFailed.forEach(m => console.log('FAILED', m.direction, m.type, m.created_at, JSON.stringify(m.metadata).slice(0, 120)));

  await p.$disconnect();
})().catch(e => { console.error('SCRIPT ERR', e); process.exit(1); });
