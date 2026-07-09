// One-off: adiciona Tenant.share_history_enabled e liga pra Diplapel.
// Uso: node scripts/apply-share-history-column.mjs   (cwd = apps/api)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_URL/DATABASE_URL ausente no .env');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "share_history_enabled" BOOLEAN NOT NULL DEFAULT false`,
  );
  console.log('Coluna share_history_enabled ok (criada ou já existia).');

  const tenants = await prisma.$queryRawUnsafe(
    `SELECT id, nome, share_history_enabled FROM "Tenant" WHERE nome ILIKE '%diplapel%'`,
  );
  console.log('Tenants diplapel:', tenants);

  if (tenants.length === 1) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Tenant" SET share_history_enabled = true WHERE id = '${tenants[0].id}'`,
    );
    console.log(`Flag ligada pra ${tenants[0].nome} (${tenants[0].id}).`);
  } else {
    console.log('0 ou >1 tenants — flag NÃO alterada, ligar manualmente.');
  }
} finally {
  await prisma.$disconnect();
}
