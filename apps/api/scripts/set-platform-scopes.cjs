// Concede escopos de admin de plataforma a um usuário.
// Uso: node scripts/set-platform-scopes.cjs <email> <escopo,escopo,...>
// Ex.:  node scripts/set-platform-scopes.cjs lucasmilagres098@gmail.com health,announcements,ai
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const VALID = ['*', 'health', 'announcements', 'ai'];
const email = process.argv[2];
const scopes = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  if (!email || scopes.length === 0) {
    console.error('Uso: node scripts/set-platform-scopes.cjs <email> <escopos separados por vírgula>');
    process.exit(1);
  }
  const invalidos = scopes.filter((s) => !VALID.includes(s));
  if (invalidos.length) {
    console.error('Escopo inválido:', invalidos.join(', '), '— válidos:', VALID.join(', '));
    process.exit(1);
  }
  const user = await p.user.findUnique({ where: { email }, select: { id: true, nome: true, tenant_id: true } });
  if (!user) {
    console.error('Usuário não encontrado:', email);
    process.exit(1);
  }
  const updated = await p.user.update({
    where: { id: user.id },
    data: { is_platform_admin: true, platform_scopes: scopes },
    select: { email: true, nome: true, is_platform_admin: true, platform_scopes: true, tenant_id: true },
  });
  console.log(JSON.stringify(updated, null, 2));
  await p.$disconnect();
})().catch(async (e) => {
  console.error('ERRO', e.message);
  await p.$disconnect();
  process.exit(1);
});
