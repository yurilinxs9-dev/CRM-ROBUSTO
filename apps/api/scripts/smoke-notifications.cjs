require('dotenv').config();
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'https://api.crmpro.uk';
const T = '8c7f38bf-6076-4279-85f0-93b24e268a2a';
const EMAIL = `notif-${Date.now()}@crm.local`;
const SENHA = 'Val1date!2026';
const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };

(async () => {
  const uid = randomUUID();
  await p.$executeRawUnsafe(
    `INSERT INTO "User"(id,nome,email,senha_hash,role,ativo,tenant_id,created_at,updated_at)
     VALUES($1,$2,$3,$4,'SUPER_ADMIN',true,$5,NOW(),NOW())`,
    uid, 'Notif Test', EMAIL, await bcrypt.hash(SENHA, 12), T);
  // seed 2 notificações
  await p.notification.createMany({ data: [
    { user_id: uid, tenant_id: T, titulo: 'Maria', conteudo: 'Oi, tudo bem?', tipo: 'message', link: '/chat/x', lida: false },
    { user_id: uid, tenant_id: T, titulo: 'João', conteudo: 'Quero orçamento', tipo: 'message', link: '/chat/y', lida: false },
  ]});
  try {
    const lj = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, senha: SENHA }) })).json();
    const tok = lj.accessToken || lj.token;
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

    const list = await (await fetch(`${BASE}/api/notifications`, { headers: H })).json();
    Array.isArray(list) && list.length >= 2 ? ok(`GET /notifications: ${list.length} itens`) : fail('GET list: ' + JSON.stringify(list).slice(0, 120));
    const unread = list.filter((n) => !n.lida).length;
    unread === 2 ? ok('2 não-lidas (badge=2)') : fail('unread=' + unread);

    const first = list[0];
    const r = await fetch(`${BASE}/api/notifications/${first.id}/read`, { method: 'PATCH', headers: H });
    r.status === 200 ? ok('PATCH /:id/read 200') : fail('mark read ' + r.status);

    const ra = await fetch(`${BASE}/api/notifications/read-all`, { method: 'PATCH', headers: H });
    const raj = await ra.json();
    ra.status === 200 && raj.ok ? ok('PATCH /read-all (updated=' + raj.updated + ')') : fail('read-all ' + ra.status);

    const after = await (await fetch(`${BASE}/api/notifications`, { headers: H })).json();
    after.every((n) => n.lida) ? ok('todas lidas após read-all') : fail('ainda há não-lidas');
  } finally {
    await p.notification.deleteMany({ where: { user_id: uid } });
    await p.user.delete({ where: { id: uid } }).catch(() => {});
    ok('cleanup');
    await p.$disconnect();
  }
  console.log('\nNotificações: OK');
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
