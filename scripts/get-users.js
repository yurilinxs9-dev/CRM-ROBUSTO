const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findMany({
    where: { role: { in: ['SUPER_ADMIN', 'GERENTE'] }, ativo: true },
    select: { email: true, role: true, tenant_id: true },
    take: 5,
  });
  console.log(JSON.stringify(u, null, 2));
  await p.$disconnect();
})();
