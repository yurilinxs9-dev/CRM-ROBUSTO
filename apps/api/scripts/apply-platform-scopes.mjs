// One-off: cria User.platform_scopes e promove os admins atuais a master.
// Uso: node scripts/apply-platform-scopes.mjs   (cwd = apps/api)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_URL/DATABASE_URL ausente no .env');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "platform_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`,
    ),
    prisma.$executeRawUnsafe(
      `UPDATE "User" SET "platform_scopes" = ARRAY['*'] WHERE "is_platform_admin" = true AND cardinality("platform_scopes") = 0`,
    ),
  ]);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT email, is_platform_admin, platform_scopes FROM "User" WHERE is_platform_admin = true ORDER BY email`,
  );
  console.log('Admins de plataforma:', rows);
} finally {
  await prisma.$disconnect();
}
