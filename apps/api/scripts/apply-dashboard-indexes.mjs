// One-off: índices pro dashboard + medição antes/depois do groupBy pesado.
// Uso: node scripts/apply-dashboard-indexes.mjs   (cwd = apps/api)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url } } });

const time = async (label, fn) => {
  const t0 = Date.now();
  const r = await fn();
  console.log(`${label}: ${Date.now() - t0}ms`);
  return r;
};

try {
  // Medição ANTES (groupBy do dashboard: msgs por atendente do maior tenant)
  const [big] = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, count(*)::int AS c FROM "Message" GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
  );
  console.log('Maior tenant (msgs):', big);

  const q = () =>
    prisma.$queryRawUnsafe(
      `SELECT sent_by_user_id, count(*)::int FROM "Message"
       WHERE tenant_id = '${big.tenant_id}' AND direction = 'OUTGOING'
         AND sent_by_user_id IS NOT NULL
       GROUP BY 1`,
    );
  await time('groupBy ANTES', q);

  await time('CREATE INDEX (tenant_id, sent_by_user_id)', () =>
    prisma.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_tenant_id_sent_by_user_id_idx"
       ON "Message"(tenant_id, sent_by_user_id)`,
    ),
  );
  await time('CREATE INDEX (tenant_id, created_at)', () =>
    prisma.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_tenant_id_created_at_idx"
       ON "Message"(tenant_id, created_at)`,
    ),
  );

  await time('groupBy DEPOIS', q);
} finally {
  await prisma.$disconnect();
}
