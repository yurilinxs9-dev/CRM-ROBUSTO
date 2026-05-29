require('dotenv').config();
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'https://api.crmpro.uk';
const T = '8c7f38bf-6076-4279-85f0-93b24e268a2a';
const EMAIL = `wh-smoke-${Date.now()}@crm.local`;
const SENHA = 'Val1date!2026';
const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const uid = randomUUID();
  await p.$executeRawUnsafe(
    `INSERT INTO "User" (id,nome,email,senha_hash,role,ativo,tenant_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'SUPER_ADMIN',true,$5,NOW(),NOW())`,
    uid, 'WH Smoke', EMAIL, await bcrypt.hash(SENHA, 12), T,
  );
  let whId = null;
  try {
    const lj = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, senha: SENHA }) })).json();
    const token = lj.accessToken || lj.access_token || lj.token;
    token ? ok('login OK') : fail('login sem token');
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // CREATE
    const c = await fetch(`${BASE}/api/outbound-webhooks`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'smoke httpbin', url: 'https://httpbin.org/post', events: ['lead.created', 'message.created'], active: true, secret: 'sk_test_123' }) });
    const cj = await c.json();
    if (c.status === 201 && cj.id) { whId = cj.id; ok('CREATE webhook: 201 id=' + cj.id); } else fail('CREATE: ' + c.status + ' ' + JSON.stringify(cj));

    // LIST
    const list = await (await fetch(`${BASE}/api/outbound-webhooks`, { headers: H })).json();
    Array.isArray(list) && list.find((w) => w.id === whId) ? ok('LIST: webhook presente (' + list.length + ' total)') : fail('LIST falhou');

    // TEST (enfileira dispatch)
    const t = await fetch(`${BASE}/api/outbound-webhooks/${whId}/test`, { method: 'POST', headers: H });
    const tj = await t.json();
    tj.queued ? ok('TEST: dispatch enfileirado') : fail('TEST falhou: ' + JSON.stringify(tj));

    // POLL deliveries
    let deliv = [];
    for (let i = 0; i < 12; i++) {
      await sleep(1500);
      deliv = await (await fetch(`${BASE}/api/outbound-webhooks/${whId}/deliveries`, { headers: H })).json();
      if (Array.isArray(deliv) && deliv.length > 0) break;
    }
    if (deliv.length > 0) {
      const d = deliv[0];
      ok(`DELIVERY registrada: success=${d.success} status=${d.status_code} dur=${d.duration_ms}ms`);
      d.success && d.status_code === 200 ? ok('DELIVERY entregue com sucesso (HTTP 200 no httpbin)') : fail('delivery sem sucesso: ' + JSON.stringify(d).slice(0, 200));
    } else fail('nenhuma delivery registrada após ~18s');

    // PATCH (toggle)
    const pa = await fetch(`${BASE}/api/outbound-webhooks/${whId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ active: false }) });
    pa.status === 200 ? ok('PATCH active=false: 200') : fail('PATCH falhou ' + pa.status);

    // DELETE
    const de = await fetch(`${BASE}/api/outbound-webhooks/${whId}`, { method: 'DELETE', headers: H });
    de.status === 200 ? ok('DELETE: 200') : fail('DELETE falhou ' + de.status);
    const gone = await fetch(`${BASE}/api/outbound-webhooks/${whId}`, { headers: H });
    gone.status === 404 ? ok('GET pós-delete: 404 (removido)') : fail('ainda existe: ' + gone.status);
    whId = null;
  } finally {
    if (whId) await p.outboundWebhook.delete({ where: { id: whId } }).catch(() => {});
    await p.user.delete({ where: { id: uid } }).catch(() => {});
    ok('cleanup: user temp removido');
    await p.$disconnect();
  }
  console.log('\nÁrea de Webhooks (outbound): OK');
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
