require('dotenv').config();
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'https://api.crmpro.uk';
const EMAIL = process.argv[2] || 'yurilinsofc@gmail.com';
const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };

(async () => {
  const user = await p.user.findUnique({ where: { email: EMAIL }, select: { id: true, email: true, role: true, tenant_id: true, is_platform_admin: true } });
  if (!user) { console.error('Usuário não encontrado:', EMAIL); process.exit(1); }
  if (!user.is_platform_admin) {
    await p.user.update({ where: { id: user.id }, data: { is_platform_admin: true } });
    ok('flag is_platform_admin=true setada em ' + EMAIL);
  } else ok('já era platform admin: ' + EMAIL);

  // JWT de teste (mesma shape do auth) pra validar os endpoints
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const stats = await (await fetch(`${BASE}/api/platform-admin/stats`, { headers: H })).json();
  typeof stats.tenants === 'number' ? ok(`stats: ${stats.tenants} tenants, ${stats.users} users, ${stats.leads} leads, ${stats.active_instances} instâncias ativas`) : fail('stats: ' + JSON.stringify(stats).slice(0, 150));

  const tenants = await (await fetch(`${BASE}/api/platform-admin/tenants`, { headers: H })).json();
  Array.isArray(tenants) && tenants.length > 0 ? ok(`tenants: ${tenants.length} listados (ex: "${tenants[0].nome}" owner=${tenants[0].owner?.email})`) : fail('tenants');

  const logs = await (await fetch(`${BASE}/api/platform-admin/logs`, { headers: H })).json();
  logs.admin_audit !== undefined ? ok('logs: admin_audit + webhook_errors + api_errors') : fail('logs');

  // anúncio
  const ann = await (await fetch(`${BASE}/api/platform-admin/announcements`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Teste', body: 'Manutenção programada', level: 'MAINTENANCE' }) })).json();
  ann.id ? ok('announcement criado id=' + ann.id) : fail('criar announcement: ' + JSON.stringify(ann).slice(0, 150));
  const active = await (await fetch(`${BASE}/api/announcements/active`, { headers: H })).json();
  Array.isArray(active) && active.find((a) => a.id === ann.id) ? ok('announcement aparece em /active') : fail('active');
  // desativa + cleanup
  if (ann.id) {
    await fetch(`${BASE}/api/platform-admin/announcements/${ann.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ active: false }) });
    await p.announcement.delete({ where: { id: ann.id } }).catch(() => {});
    ok('announcement desativado + removido (cleanup)');
  }

  // guard: usuário NÃO-admin é barrado
  const someUser = await p.user.findFirst({ where: { is_platform_admin: false }, select: { id: true, email: true, role: true, tenant_id: true } });
  if (someUser) {
    const t2 = jwt.sign({ sub: someUser.id, email: someUser.email, role: someUser.role, tenantId: someUser.tenant_id }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(`${BASE}/api/platform-admin/stats`, { headers: { Authorization: `Bearer ${t2}` } });
    r.status === 403 ? ok('guard: não-admin → 403') : fail('guard furado: ' + r.status);
  }
  await p.$disconnect();
  console.log('\nPlatform admin backend: OK');
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
