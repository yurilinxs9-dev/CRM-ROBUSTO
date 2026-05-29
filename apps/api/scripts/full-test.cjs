require('dotenv').config();
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'https://api.crmpro.uk';
const V1 = `${BASE}/api/v1`;
const T = '8c7f38bf-6076-4279-85f0-93b24e268a2a';
const EMAIL = `fulltest-${Date.now()}@crm.local`;
const SENHA = 'Val1date!2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, failc = 0;
const ok = (m) => { pass++; console.log('  ✓', m); };
const fail = (m) => { failc++; console.log('  ✗ FAIL:', m); };
const J = async (r) => { try { return await r.json(); } catch { return {}; } };

(async () => {
  const uid = randomUUID();
  await p.$executeRawUnsafe(
    `INSERT INTO "User" (id,nome,email,senha_hash,role,ativo,tenant_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'SUPER_ADMIN',true,$5,NOW(),NOW())`,
    uid, 'Full Test', EMAIL, await bcrypt.hash(SENHA, 12), T);

  const leadIds = [];
  let fullKeyId = null, limitedKeyId = null, whId = null;
  try {
    // ===== HEALTH + AUTH =====
    console.log('\n[ Infra & Auth ]');
    const h = await fetch(`${BASE}/api/health`);
    h.status === 200 ? ok('health 200') : fail('health ' + h.status);
    const lj = await J(await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, senha: SENHA }) }));
    const jwt = lj.accessToken || lj.access_token || lj.token;
    jwt ? ok('login → accessToken') : fail('login sem token');
    const JH = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
    const me = await fetch(`${BASE}/api/auth/me`, { headers: JH });
    me.status === 200 ? ok('GET /auth/me 200') : fail('/auth/me ' + me.status);

    // ===== API KEY MGMT (JWT) =====
    console.log('\n[ Gestão de API Keys ]');
    const ck = await fetch(`${BASE}/api/api-keys`, { method: 'POST', headers: JH, body: JSON.stringify({ name: 'fulltest-all', scopes: ['contacts:read', 'contacts:write', 'conversations:read', 'conversations:write', 'tags:write'] }) });
    const ckj = await J(ck);
    let token = null;
    if (ck.status === 201 && ckj.token) { token = ckj.token; fullKeyId = ckj.id; ok('POST /api/api-keys → token crmk_'); } else fail('criar key ' + ck.status);
    const ck2 = await J(await fetch(`${BASE}/api/api-keys`, { method: 'POST', headers: JH, body: JSON.stringify({ name: 'fulltest-limited', scopes: ['contacts:read'] }) }));
    const limitedToken = ck2.token; limitedKeyId = ck2.id;
    limitedToken ? ok('POST key limitada (contacts:read)') : fail('criar key limitada');
    const klist = await J(await fetch(`${BASE}/api/api-keys`, { headers: JH }));
    Array.isArray(klist) && klist.find((k) => k.id === fullKeyId) && !klist[0].token ? ok('GET /api/api-keys (lista, sem token)') : fail('listar keys');
    const usage = await fetch(`${BASE}/api/api-keys/usage`, { headers: JH });
    usage.status === 200 ? ok('GET /api/api-keys/usage 200') : fail('usage ' + usage.status);

    const KH = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // ===== OPENAPI =====
    console.log('\n[ OpenAPI ]');
    const oas = await J(await fetch(`${V1}/openapi.json`));
    oas.openapi && oas.paths['/users'] ? ok(`openapi.json (${Object.keys(oas.paths).length} paths)`) : fail('openapi');

    // ===== AUTH/SCOPE ENFORCEMENT =====
    console.log('\n[ Auth & Escopos ]');
    (await fetch(`${V1}/users`)).status === 401 ? ok('sem token → 401') : fail('esperava 401 sem token');
    (await fetch(`${V1}/users`, { headers: { Authorization: 'Bearer crmk_errado' } })).status === 401 ? ok('token inválido → 401') : fail('esperava 401 token ruim');
    (await fetch(`${V1}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${limitedToken}` }, body: JSON.stringify({ name: 'x', phone: '5511999990000' }) })).status === 403 ? ok('escopo insuficiente → 403') : fail('esperava 403 escopo');

    // ===== CONTATOS =====
    console.log('\n[ Contatos ]');
    const phone = '5511' + Math.floor(100000000 + Math.random() * 800000000);
    const cc = await fetch(`${V1}/users`, { method: 'POST', headers: KH, body: JSON.stringify({ name: 'Contato Teste', phone, email: 'ct@test.local', tags: ['full'] }) });
    const ccj = await J(cc);
    let cid = null;
    if (cc.status === 201 && ccj.id) { cid = ccj.id; leadIds.push(cid); ok('POST /v1/users 201'); } else fail('criar contato ' + cc.status);
    (await fetch(`${V1}/users?phone=${phone}`, { headers: KH }).then(J)).data?.length >= 1 ? ok('GET /v1/users?phone= filtra') : fail('listar/filtrar contatos');
    const one = await fetch(`${V1}/users/${cid}`, { headers: KH });
    one.status === 200 ? ok('GET /v1/users/:id 200') : fail('get contato ' + one.status);
    const pa = await fetch(`${V1}/users/${cid}`, { method: 'PATCH', headers: KH, body: JSON.stringify({ name: 'Contato Renomeado', tags: ['full', 'edit'] }) });
    (await J(pa)).name === 'Contato Renomeado' ? ok('PATCH /v1/users/:id atualiza') : fail('patch contato ' + pa.status);
    (await fetch(`${V1}/users/00000000-0000-0000-0000-000000000000`, { headers: KH })).status === 404 ? ok('GET contato inexistente → 404') : fail('esperava 404');

    // ===== CONVERSAS =====
    console.log('\n[ Conversas ]');
    const tg = await fetch(`${V1}/conversations/${cid}/tags`, { method: 'POST', headers: KH, body: JSON.stringify({ tags: ['suporte', 'vip'] }) });
    (await J(tg)).tags?.includes('suporte') ? ok('POST /v1/conversations/:id/tags') : fail('add tags ' + tg.status);
    const st = await fetch(`${V1}/conversations/${cid}/status`, { method: 'PATCH', headers: KH, body: JSON.stringify({ status: 'resolved' }) });
    (await J(st)).status === 'RESOLVED' ? ok('PATCH status → RESOLVED') : fail('status ' + st.status);
    const cl = await J(await fetch(`${V1}/conversations?status=resolved&limit=50`, { headers: KH }));
    Array.isArray(cl.data) && cl.data.find((x) => x.conversation_id === cid) ? ok('GET /v1/conversations?status=resolved acha') : fail('listar conversas');
    const conv = await fetch(`${V1}/conversations/${cid}`, { headers: KH });
    const convj = await J(conv);
    conv.status === 200 && Array.isArray(convj.messages) ? ok('GET /v1/conversations/:id (histórico)') : fail('get conversa ' + conv.status);
    const send = await fetch(`${V1}/conversations`, { method: 'POST', headers: KH, body: JSON.stringify({ user_id: cid, message: 'teste automatizado' }) });
    [201, 400, 403, 404, 502].includes(send.status) ? ok(`POST /v1/conversations → ${send.status} (controlado; sem instância conectada no tenant teste é esperado)`) : fail('send status inesperado ' + send.status);

    // ===== IDEMPOTÊNCIA =====
    console.log('\n[ Idempotência ]');
    const ph2 = '5511' + Math.floor(100000000 + Math.random() * 800000000);
    const body2 = JSON.stringify({ name: 'Idem', phone: ph2 });
    const i1 = await J(await fetch(`${V1}/users`, { method: 'POST', headers: { ...KH, 'Idempotency-Key': 'ft-idem-1' }, body: body2 }));
    if (i1.id) leadIds.push(i1.id);
    const i2r = await fetch(`${V1}/users`, { method: 'POST', headers: { ...KH, 'Idempotency-Key': 'ft-idem-1' }, body: body2 });
    const i2 = await J(i2r);
    i2.id === i1.id && i2r.headers.get('idempotent-replayed') === 'true' ? ok('Idempotency-Key replay (sem duplicar)') : fail('idempotência');
    (await p.lead.count({ where: { tenant_id: T, telefone: ph2 } })) === 1 ? ok('idempotência: 1 contato só') : fail('duplicou contato');

    // ===== AUDITORIA =====
    console.log('\n[ Auditoria ]');
    await sleep(1000);
    const logs = await p.apiRequestLog.count({ where: { tenant_id: T, api_key_id: fullKeyId } });
    logs >= 8 ? ok(`ApiRequestLog: ${logs} requisições logadas`) : fail('auditoria só ' + logs + ' logs');

    // ===== WEBHOOKS OUTBOUND =====
    console.log('\n[ Webhooks de saída ]');
    const wc = await J(await fetch(`${BASE}/api/outbound-webhooks`, { method: 'POST', headers: JH, body: JSON.stringify({ name: 'ft-wh', url: 'https://httpbin.org/post', events: ['lead.created'], active: true, secret: 'sk_1' }) }));
    whId = wc.id;
    whId ? ok('CREATE webhook') : fail('criar webhook');
    (await J(await fetch(`${BASE}/api/outbound-webhooks/${whId}/test`, { method: 'POST', headers: JH }))).queued ? ok('TEST dispatch enfileirado') : fail('test webhook');
    let dv = [];
    for (let i = 0; i < 12; i++) { await sleep(1500); dv = await J(await fetch(`${BASE}/api/outbound-webhooks/${whId}/deliveries`, { headers: JH })); if (dv.length) break; }
    dv[0]?.success && dv[0]?.status_code === 200 ? ok('DELIVERY entregue (HTTP 200)') : fail('delivery: ' + JSON.stringify(dv[0] || {}).slice(0, 150));
    (await fetch(`${BASE}/api/outbound-webhooks/${whId}`, { method: 'DELETE', headers: JH })).status === 200 ? ok('DELETE webhook') : fail('delete webhook');
    whId = null;
  } finally {
    console.log('\n[ Cleanup ]');
    for (const id of leadIds) await p.lead.delete({ where: { id } }).catch(() => {});
    if (whId) await p.outboundWebhook.delete({ where: { id: whId } }).catch(() => {});
    await p.apiRequestLog.deleteMany({ where: { api_key_id: { in: [fullKeyId, limitedKeyId].filter(Boolean) } } }).catch(() => {});
    await p.apiKey.deleteMany({ where: { id: { in: [fullKeyId, limitedKeyId].filter(Boolean) } } }).catch(() => {});
    await p.user.delete({ where: { id: uid } }).catch(() => {});
    console.log('  ✓ removido: contatos, webhook, keys, logs, user temp');
    await p.$disconnect();
  }
  console.log(`\n===== RESULTADO: ${pass} PASS / ${failc} FAIL =====`);
  process.exit(failc > 0 ? 1 : 0);
})().catch(async (e) => { console.error('ERRO FATAL', e.message); await p.$disconnect(); process.exit(1); });
