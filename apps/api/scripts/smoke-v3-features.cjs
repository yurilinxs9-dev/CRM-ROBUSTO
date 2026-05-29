require('dotenv').config();
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'https://api.crmpro.uk/api/v1';
const T = '8c7f38bf-6076-4279-85f0-93b24e268a2a';
const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const mkKey = (scopes) => {
  const token = 'crmk_' + crypto.randomBytes(32).toString('base64url');
  return { token, prefix: token.slice(0, 13), hash: crypto.createHash('sha256').update(token).digest('hex'), scopes };
};

(async () => {
  const k = mkKey(['contacts:read', 'contacts:write', 'conversations:read', 'conversations:write']);
  const key = await p.apiKey.create({ data: { tenant_id: T, name: 'smoke-v3', key_hash: k.hash, prefix: k.prefix, scopes: k.scopes } });
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${k.token}` };
  const phone = '5511' + Math.floor(100000000 + Math.random() * 800000000);
  const ids = [];
  try {
    // 1. OpenAPI público (sem auth)
    const oas = await fetch(`${BASE}/openapi.json`);
    const oj = await oas.json();
    oas.status === 200 && oj.openapi && oj.paths['/users'] ? ok(`OpenAPI: 200, openapi=${oj.openapi}, ${Object.keys(oj.paths).length} paths`) : fail('OpenAPI falhou: ' + oas.status);

    // 2. Idempotência: POST /users 2x com mesma Idempotency-Key
    const body = JSON.stringify({ name: 'Idem Test', phone, tags: ['v3'] });
    const r1 = await fetch(`${BASE}/users`, { method: 'POST', headers: { ...H, 'Idempotency-Key': 'idem-abc-123' }, body });
    const j1 = await r1.json();
    if (r1.status === 201 && j1.id) { ids.push(j1.id); ok('POST /users #1: 201 id=' + j1.id); } else fail('POST #1: ' + r1.status + ' ' + JSON.stringify(j1));
    const r2 = await fetch(`${BASE}/users`, { method: 'POST', headers: { ...H, 'Idempotency-Key': 'idem-abc-123' }, body });
    const j2 = await r2.json();
    const replayed = r2.headers.get('idempotent-replayed');
    j2.id === j1.id && replayed === 'true' ? ok('POST /users #2 (mesma key): replay id idêntico + header Idempotent-Replayed=true') : fail('idempotência falhou: id2=' + j2.id + ' replayed=' + replayed);
    const dup = await p.lead.count({ where: { tenant_id: T, telefone: phone } });
    dup === 1 ? ok('idempotência: só 1 contato criado (sem duplicata)') : fail('duplicou: ' + dup + ' contatos');

    // 3. PATCH /users/:id
    const pr = await fetch(`${BASE}/users/${j1.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ name: 'Idem Renamed', tags: ['v3', 'editado'] }) });
    const pj = await pr.json();
    pr.status === 200 && pj.name === 'Idem Renamed' && pj.tags.includes('editado') ? ok('PATCH /users/:id: 200, nome+tags atualizados') : fail('PATCH falhou: ' + pr.status + ' ' + JSON.stringify(pj));

    // 4. GET /conversations (+filtro status)
    const lc = await fetch(`${BASE}/conversations?status=open&limit=10`, { headers: H });
    const lj = await lc.json();
    lc.status === 200 && Array.isArray(lj.data) && lj.data[0] && lj.data[0].conversation_id ? ok(`GET /conversations?status=open: 200, ${lj.data.length} conversa(s)`) : fail('GET /conversations falhou: ' + lc.status + ' ' + JSON.stringify(lj).slice(0, 150));

    // 5. Auditoria: logs gravados pra essa chave
    await new Promise((r) => setTimeout(r, 800)); // dá tempo do fire-and-forget
    const logs = await p.apiRequestLog.count({ where: { tenant_id: T, api_key_id: key.id } });
    logs >= 3 ? ok(`auditoria: ${logs} requisições logadas em ApiRequestLog`) : fail('auditoria: só ' + logs + ' logs (esperava >=3)');
  } finally {
    for (const id of ids) await p.lead.delete({ where: { id } }).catch(() => {});
    await p.apiRequestLog.deleteMany({ where: { api_key_id: key.id } });
    await p.apiKey.delete({ where: { id: key.id } });
    ok('cleanup: contato + logs + key removidos');
    await p.$disconnect();
  }
  console.log('\nFeatures v3 (OpenAPI, PATCH, GET conversations, idempotência, auditoria): OK');
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
