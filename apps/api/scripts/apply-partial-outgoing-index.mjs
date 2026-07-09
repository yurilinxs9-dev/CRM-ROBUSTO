// One-off: índice parcial p/ groupBy de msgs enviadas por atendente (dashboard).
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
});
const time = async (label, fn) => {
  const t0 = Date.now();
  const r = await fn();
  console.log(`${label}: ${Date.now() - t0}ms`);
  return r;
};

try {
  await time('partial idx', () =>
    prisma.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_outgoing_by_user_idx"
       ON "Message"(tenant_id, sent_by_user_id)
       WHERE direction = 'OUTGOING' AND sent_by_user_id IS NOT NULL`,
    ),
  );
  await time('groupBy pós-parcial', () =>
    prisma.$queryRawUnsafe(
      `SELECT sent_by_user_id, count(*)::int FROM "Message"
       WHERE tenant_id = 'bb4953ac-b37f-4445-81c0-f54508c77141'
         AND direction = 'OUTGOING' AND sent_by_user_id IS NOT NULL
       GROUP BY 1`,
    ),
  );
} finally {
  await prisma.$disconnect();
}
