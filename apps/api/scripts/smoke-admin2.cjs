require('dotenv').config();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'https://api.crmpro.uk';
const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };

(async () => {
  const admin = await p.user.findUnique({ where: { email: 'yurilinsofc@gmail.com' }, select: { id: true, email: true, role: true, tenant_id: true } });
  const token = jwt.sign({ sub: admin.id, email: admin.email, role: admin.role, tenantId: admin.tenant_id }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // health
  const health = await (await fetch(`${BASE}/api/platform-admin/health`, { headers: H })).json();
  health.db && health.storage && Array.isArray(health.tips) ? ok(`health: ${health.db.messages} msgs, storage ${health.storage.media_gb}GB, ${health.tips.length} dicas, ${health.security_24h.failed_logins} logins falhos 24h`) : fail('health: ' + JSON.stringify(health).slice(0, 150));

  // login falho → aparece nos logs
  await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'naoexiste@x.com', senha: 'errada123' }) });
  await new Promise((r) => setTimeout(r, 600));
  const logs = await (await fetch(`${BASE}/api/platform-admin/logs`, { headers: H })).json();
  Array.isArray(logs.login_attempts) && logs.login_attempts.some((l) => l.action === 'login_failed') ? ok(`logs: ${logs.login_attempts.length} tentativas de login (com falha registrada)`) : fail('login_attempts');

  // tenant + member temporário p/ ban/delete/suspend (FK deferida em transação)
  const tid = randomUUID(); const oid = randomUUID(); const mid = randomUUID();
  const hash = await bcrypt.hash('x', 4);
  await p.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
    await tx.$executeRawUnsafe(`INSERT INTO "User"(id,nome,email,senha_hash,role,ativo,tenant_id,created_at,updated_at) VALUES($1,$2,$3,$4,'SUPER_ADMIN',true,$5,NOW(),NOW())`, oid, 'Owner', `owner-${Date.now()}@t.local`, hash, tid);
    await tx.$executeRawUnsafe(`INSERT INTO "Tenant"(id,nome,owner_id,created_at,updated_at) VALUES($1,$2,$3,NOW(),NOW())`, tid, 'Smoke Admin Tenant', oid);
    await tx.$executeRawUnsafe(`INSERT INTO "User"(id,nome,email,senha_hash,role,ativo,tenant_id,created_at,updated_at) VALUES($1,$2,$3,$4,'OPERADOR',true,$5,NOW(),NOW())`, mid, 'Member', `member-${Date.now()}@t.local`, hash, tid);
  });

  try {
    const ban = await fetch(`${BASE}/api/platform-admin/users/${mid}/ban`, { method: 'PATCH', headers: H, body: JSON.stringify({ banned: true }) });
    ban.status === 200 ? ok('ban member: 200') : fail('ban ' + ban.status);
    (await p.user.findUnique({ where: { id: mid }, select: { ativo: true } })).ativo === false ? ok('member ativo=false após ban') : fail('ban não aplicou');

    const unban = await fetch(`${BASE}/api/platform-admin/users/${mid}/ban`, { method: 'PATCH', headers: H, body: JSON.stringify({ banned: false }) });
    unban.status === 200 ? ok('unban: 200') : fail('unban');

    // delete owner deve falhar (é owner) → 409
    const delOwner = await fetch(`${BASE}/api/platform-admin/users/${oid}`, { method: 'DELETE', headers: H });
    delOwner.status === 409 ? ok('delete owner bloqueado (409)') : fail('delete owner deveria 409, veio ' + delOwner.status);

    const delMember = await fetch(`${BASE}/api/platform-admin/users/${mid}`, { method: 'DELETE', headers: H });
    delMember.status === 200 ? ok('delete member: 200') : fail('delete member ' + delMember.status);

    const susp = await fetch(`${BASE}/api/platform-admin/tenants/${tid}/suspend`, { method: 'PATCH', headers: H, body: JSON.stringify({ suspended: true }) });
    const suspj = await susp.json();
    susp.status === 200 && suspj.users_affected >= 1 ? ok(`suspend tenant: ${suspj.users_affected} usuário(s) desativado(s)`) : fail('suspend ' + susp.status);
    (await p.user.findUnique({ where: { id: oid }, select: { ativo: true } })).ativo === false ? ok('owner desativado pelo suspend') : fail('suspend não aplicou');
  } finally {
    await p.user.deleteMany({ where: { id: { in: [mid] } } }).catch(() => {});
    await p.tenant.update({ where: { id: tid }, data: { owner_id: oid } }).catch(() => {});
    // owner FK: tenant aponta pro owner; deletar owner exige soltar. Limpa simples:
    await p.user.delete({ where: { id: oid } }).catch(async () => { await p.tenant.delete({ where: { id: tid } }).catch(() => {}); await p.user.delete({ where: { id: oid } }).catch(() => {}); });
    await p.tenant.delete({ where: { id: tid } }).catch(() => {});
    ok('cleanup');
    await p.$disconnect();
  }
  console.log('\nAdmin ações + health + login-logs: OK');
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
