require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const id = process.argv[2];
if (!id) { console.error('Uso: node scripts/revoke-api-key.cjs <apiKeyId>'); process.exit(1); }
(async () => {
  const r = await p.apiKey.update({
    where: { id },
    data: { active: false, revoked_at: new Date() },
    select: { id: true, name: true, active: true, revoked_at: true },
  });
  console.log('revoked:', JSON.stringify(r));
  await p.$disconnect();
})().catch(async (e) => { console.error(e.message); await p.$disconnect(); process.exit(1); });
