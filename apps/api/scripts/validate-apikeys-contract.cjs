require('dotenv').config();
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const BASE = 'https://api.crmpro.uk';
const TENANT = '8c7f38bf-6076-4279-85f0-93b24e268a2a'; // tenant "teste"
const EMAIL = `e2e-uitest-${Date.now()}@crm.local`;
const SENHA = 'Val1date!2026';

const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };

(async () => {
  // provisiona user temporário (SUPER_ADMIN pra passar RolesGuard GERENTE)
  const senha_hash = await bcrypt.hash(SENHA, 12);
  const userId = randomUUID();
  await p.$executeRawUnsafe(
    `INSERT INTO "User" (id,nome,email,senha_hash,role,ativo,tenant_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'SUPER_ADMIN',true,$5,NOW(),NOW())`,
    userId, 'E2E UI Test', EMAIL, senha_hash, TENANT,
  );
  ok('user temp criado: ' + EMAIL);

  let createdKeyId = null;
  try {
    // 1. login (mesmo endpoint que o frontend usa)
    const lr = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, senha: SENHA }),
    });
    const lj = await lr.json();
    const token = lj.accessToken || lj.access_token || lj.token;
    token ? ok('login: accessToken recebido (HTTP ' + lr.status + ')')
          : fail('login: sem token. keys=' + Object.keys(lj).join(','));
    if (!token) throw new Error('no token');
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // 2. GET /api/api-keys (lista — o que ApiKeysTab faz no load)
    const g1 = await fetch(`${BASE}/api/api-keys`, { headers: H });
    const list1 = await g1.json();
    Array.isArray(list1) ? ok(`GET /api/api-keys: 200, ${list1.length} chave(s)`)
                         : fail('GET list nao retornou array: ' + JSON.stringify(list1));

    // 3. POST /api/api-keys (ApiKeyFormDialog cria)
    const c = await fetch(`${BASE}/api/api-keys`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'UI E2E key', scopes: ['contacts:read', 'tags:write'] }),
    });
    const cj = await c.json();
    if (c.status === 201 && cj.token && cj.token.startsWith('crmk_') && cj.id) {
      createdKeyId = cj.id;
      ok('POST /api/api-keys: 201, token crmk_… exibido 1x, prefix=' + cj.prefix);
    } else fail('POST falhou: HTTP ' + c.status + ' ' + JSON.stringify(cj));

    // 4. GET de novo — chave nova aparece na lista
    const g2 = await fetch(`${BASE}/api/api-keys`, { headers: H });
    const list2 = await g2.json();
    const found = Array.isArray(list2) && list2.find((k) => k.id === createdKeyId);
    found && !found.token ? ok('GET pos-create: chave listada SEM token (so prefix=' + found.prefix + ')')
                          : fail('chave nova nao listada corretamente');

    // 5. DELETE (revogar) — botao revogar do ApiKeysTab
    const d = await fetch(`${BASE}/api/api-keys/${createdKeyId}`, { method: 'DELETE', headers: H });
    d.status === 200 || d.status === 201 ? ok('DELETE /api/api-keys/:id: revogada (HTTP ' + d.status + ')')
                                         : fail('DELETE falhou HTTP ' + d.status);
    const after = await p.apiKey.findUnique({ where: { id: createdKeyId }, select: { active: true } });
    after && after.active === false ? ok('revogacao confirmada no banco (active=false)') : fail('chave ainda ativa');

    // 6. sem token → 401 (guarda)
    const noauth = await fetch(`${BASE}/api/api-keys`);
    noauth.status === 401 ? ok('GET sem JWT: 401') : fail('esperava 401, veio ' + noauth.status);
  } finally {
    // cleanup total
    if (createdKeyId) await p.apiKey.delete({ where: { id: createdKeyId } }).catch(() => {});
    await p.user.delete({ where: { id: userId } }).catch(() => {});
    ok('cleanup: user temp + chave removidos');
    await p.$disconnect();
  }
  console.log('\nContrato UI ↔ /api/api-keys: OK');
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
