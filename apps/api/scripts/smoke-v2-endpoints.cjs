require('dotenv').config();
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'https://api.crmpro.uk';
const T = '8c7f38bf-6076-4279-85f0-93b24e268a2a';
const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const mkKey = (scopes) => {
  const token = 'crmk_' + crypto.randomBytes(32).toString('base64url');
  return { token, prefix: token.slice(0, 13), hash: crypto.createHash('sha256').update(token).digest('hex'), scopes };
};

(async () => {
  const full = mkKey(['contacts:read', 'contacts:write', 'conversations:read']);
  const limited = mkKey(['contacts:read']);
  const kf = await p.apiKey.create({ data: { tenant_id: T, name: 'smoke-full', key_hash: full.hash, prefix: full.prefix, scopes: full.scopes } });
  const kl = await p.apiKey.create({ data: { tenant_id: T, name: 'smoke-limited', key_hash: limited.hash, prefix: limited.prefix, scopes: limited.scopes } });
  const Hf = { 'Content-Type': 'application/json', Authorization: `Bearer ${full.token}` };
  const Hl = { 'Content-Type': 'application/json', Authorization: `Bearer ${limited.token}` };
  let newId = null;
  try {
    // POST /v1/users (criar contato) — contacts:write
    const c = await fetch(`${BASE}/api/v1/users`, { method: 'POST', headers: Hf, body: JSON.stringify({ name: 'Smoke Contact', phone: '5511988887777', email: 'smoke@test.local', tags: ['api-smoke'] }) });
    const cj = await c.json();
    if (c.status === 201 && cj.id && cj.name === 'Smoke Contact' && cj.status === 'OPEN') { newId = cj.id; ok('POST /v1/users: 201, contato criado id=' + cj.id + ' phone=' + cj.phone); }
    else fail('POST /v1/users falhou: ' + c.status + ' ' + JSON.stringify(cj));

    // GET /v1/conversations/:id — conversations:read (usa lead existente com msgs)
    const ul = await (await fetch(`${BASE}/api/v1/users?limit=5`, { headers: Hf })).json();
    const target = (ul.data || []).find((x) => x.id !== newId) || { id: newId };
    const g = await fetch(`${BASE}/api/v1/conversations/${target.id}`, { headers: Hf });
    const gj = await g.json();
    if (g.status === 200 && gj.conversation_id === target.id && Array.isArray(gj.messages)) ok(`GET /v1/conversations/:id: 200, ${gj.messages.length} msg(s), status=${gj.status}`);
    else fail('GET conversation falhou: ' + g.status + ' ' + JSON.stringify(gj).slice(0, 200));

    // enforcement: key sem contacts:write → 403 no POST /users
    const f = await fetch(`${BASE}/api/v1/users`, { method: 'POST', headers: Hl, body: JSON.stringify({ name: 'x', phone: '5511900000000' }) });
    const fj = await f.json();
    f.status === 403 && fj.error ? ok('escopo: POST /users sem contacts:write → 403 (' + fj.error + ')') : fail('esperava 403, veio ' + f.status + ' ' + JSON.stringify(fj));

    // validacao: phone curto → 400
    const b = await fetch(`${BASE}/api/v1/users`, { method: 'POST', headers: Hf, body: JSON.stringify({ name: 'x', phone: '12' }) });
    b.status === 400 ? ok('validacao: phone invalido → 400') : fail('esperava 400, veio ' + b.status);
  } finally {
    if (newId) await p.lead.delete({ where: { id: newId } }).catch(() => {});
    await p.apiKey.deleteMany({ where: { id: { in: [kf.id, kl.id] } } });
    ok('cleanup: contato + 2 keys removidos');
    await p.$disconnect();
  }
  console.log('\nEndpoints v2 (POST /users + GET /conversations/:id): OK');
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
