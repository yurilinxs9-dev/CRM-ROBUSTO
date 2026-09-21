try { await import('dotenv/config'); } catch { /* environment variables are sufficient */ }
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
const tables = ['FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit'];
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../prisma/migrations/20260921150000_paloma_finance/migration.sql'),'utf8');
const statements = sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
for (const statement of statements) {
  const match = statement.match(/^(?:CREATE TABLE|ALTER TABLE)\s+"([^"]+)"|^CREATE (?:UNIQUE )?INDEX\s+"[^"]+"\s+ON\s+"([^"]+)"/i);
  if (!match || !tables.includes(match[1] ?? match[2]) || /\b(DROP|TRUNCATE|INSERT|DELETE FROM|UPDATE\s+")\b/i.test(statement)) throw new Error('Migration is not restricted to creating the six new finance tables');
}
for (const table of tables) {
  if (!statements.some(statement => statement === `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)) throw new Error(`Missing RLS for ${table}`);
}
console.log(`Validated additive SQL: ${statements.length} statements, ${tables.length} new tables.`);
if (process.argv.includes('--check-sql')) process.exit(0);
const directUrl = process.env.DIRECT_URL;
if (!directUrl || new URL(directUrl).port !== '5432') throw new Error('DIRECT_URL with direct PostgreSQL port 5432 is required');
const apply = process.argv.includes('--apply');
if (apply && process.argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run');
const prisma = new PrismaClient({datasources:{db:{url:directUrl}}});
// Compare structure, never row counts: live CRM traffic may change counts legitimately.
const structureQuery = `SELECT c.relname AS name, a.attname AS column, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default_value
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND c.relname NOT IN ('FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit') ORDER BY c.relname,a.attnum`;
const constraintsQuery = `SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname NOT IN ('FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit') ORDER BY c.relname,con.conname`;
const indexesQuery = `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename NOT IN ('FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit') ORDER BY tablename,indexname`;
try {
  const existing = await prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit')`);
  if (existing.length) throw new Error('Some finance tables already exist; inspect schema before applying or registering migration. No automatic overwrite.');
  const required = await prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('Tenant','User','Lead')`);
  if (required.length !== 3) throw new Error('CRM prerequisite tables are missing');
  if (!apply) { console.log('Dry-run (default): prerequisites present; nothing applied. Run with --apply explicitly.'); process.exitCode=0; }
  else {
    await prisma.$transaction(async tx=>{
      const before=JSON.stringify([await tx.$queryRawUnsafe(structureQuery),await tx.$queryRawUnsafe(constraintsQuery),await tx.$queryRawUnsafe(indexesQuery)]);
      for(const statement of statements) await tx.$executeRawUnsafe(statement);
      const after=JSON.stringify([await tx.$queryRawUnsafe(structureQuery),await tx.$queryRawUnsafe(constraintsQuery),await tx.$queryRawUnsafe(indexesQuery)]);
      if(before!==after) throw new Error('Existing table structure changed; rolling back');
      const created=await tx.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit')`);
      if(created.length!==6) throw new Error('Not all new tables were created; rolling back');
      const rls = await tx.$queryRawUnsafe(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit')`);
      if(rls.length!==6 || rls.some(table=>!table.relrowsecurity)) throw new Error('Finance RLS is not enabled on every new table; rolling back');
    },{timeout:60000});
    console.log('Applied atomically; existing CRM structure preserved. No credentials or financial records seeded.');
    console.log('Register afterwards using DIRECT_URL as DATABASE_URL: node ../../node_modules/prisma/build/index.js migrate resolve --applied 20260921150000_paloma_finance');
  }
} finally { await prisma.$disconnect(); }
