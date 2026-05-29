/* eslint-disable */
// Cria uma API key para um tenant. Uso:
//   node scripts/create-api-key.js                 -> lista tenants
//   node scripts/create-api-key.js <tenantId> [nome] [scopes,csv]
// Imprime o token em CLARO uma única vez (igual fluxo da API).
require('dotenv').config();
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ALL_SCOPES = ['contacts:read', 'contacts:write', 'conversations:read', 'conversations:write', 'tags:write'];

function genKey() {
  const raw = crypto.randomBytes(32).toString('base64url');
  const token = `crmk_${raw}`;
  return { token, prefix: token.slice(0, 13), hash: crypto.createHash('sha256').update(token, 'utf8').digest('hex') };
}

(async () => {
  const [, , tenantId, name, scopesCsv] = process.argv;

  if (!tenantId) {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, nome: true, owner_id: true, _count: { select: { leads: true } } },
      orderBy: { created_at: 'asc' },
    });
    console.log('Tenants disponíveis:');
    for (const t of tenants) console.log(`  ${t.id}  "${t.nome}"  leads=${t._count.leads}`);
    console.log('\nRode: node scripts/create-api-key.js <tenantId> "Integração teste" "contacts:read,conversations:write,tags:write"');
    await prisma.$disconnect();
    return;
  }

  const scopes = (scopesCsv ? scopesCsv.split(',') : ALL_SCOPES).map((s) => s.trim()).filter(Boolean);
  const bad = scopes.filter((s) => !ALL_SCOPES.includes(s));
  if (bad.length) { console.error('Scopes inválidos:', bad.join(', ')); process.exit(1); }

  const { token, prefix, hash } = genKey();
  const created = await prisma.apiKey.create({
    data: { tenant_id: tenantId, name: name || 'Integração teste', key_hash: hash, prefix, scopes },
    select: { id: true, name: true, prefix: true, scopes: true, created_at: true },
  });

  console.log('\n=== API KEY CRIADA ===');
  console.log('id     :', created.id);
  console.log('name   :', created.name);
  console.log('scopes :', created.scopes.join(', '));
  console.log('prefix :', created.prefix);
  console.log('\nTOKEN (guarde — exibido só agora):');
  console.log(token);
  console.log('======================\n');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
