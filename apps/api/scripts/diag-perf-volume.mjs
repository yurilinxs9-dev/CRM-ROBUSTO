// Diagnóstico: volume de leads/msgs por tenant + tamanho estimado do payload do board.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT t.nome,
           count(l.id)::int AS leads,
           count(l.id) FILTER (WHERE l.archived_at IS NULL)::int AS leads_ativos,
           (SELECT count(*)::int FROM "Message" m WHERE m.tenant_id = t.id) AS msgs
    FROM "Tenant" t LEFT JOIN "Lead" l ON l.tenant_id = t.id
    GROUP BY t.id, t.nome ORDER BY leads DESC LIMIT 10
  `);
  console.table(rows);
} catch (e) {
  // archived_at pode não existir — fallback simples
  console.error('fallback:', e.message?.slice(0, 120));
  const rows = await prisma.$queryRawUnsafe(`
    SELECT t.nome, count(l.id)::int AS leads,
           (SELECT count(*)::int FROM "Message" m WHERE m.tenant_id = t.id) AS msgs
    FROM "Tenant" t LEFT JOIN "Lead" l ON l.tenant_id = t.id
    GROUP BY t.id, t.nome ORDER BY leads DESC LIMIT 10
  `);
  console.table(rows);
} finally {
  await prisma.$disconnect();
}
