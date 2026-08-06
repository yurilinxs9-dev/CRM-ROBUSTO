// One-off: aplica 20260806090000_kommo_custom_fields (escopos, grupos,
// Contact/Company/LeadContact).
//
// Uso: node scripts/apply-kommo-fields.mjs            (cwd = apps/api)
//      node scripts/apply-kommo-fields.mjs --dry-run  (só confere e mostra)
//
// Lê os statements do próprio migration.sql, separados por "-- @@SPLIT", pra
// não existirem duas cópias da DDL que possam divergir.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(
  AQUI,
  '..',
  'prisma',
  'migrations',
  '20260806090000_kommo_custom_fields',
  'migration.sql',
);

const dryRun = process.argv.includes('--dry-run');

// Regra 3 do CLAUDE.md: migration SEMPRE pela conexão direta. A DATABASE_URL
// aponta pro pgBouncer (6543, modo transaction), que não lida bem com DDL nem
// com transação multi-statement.
const url = process.env.DIRECT_URL;
if (!url) {
  console.error('DIRECT_URL ausente. Migration exige a conexão direta (porta 5432).');
  process.exit(1);
}
if (!url.includes(':5432')) {
  console.error(`DIRECT_URL não aponta para a porta 5432 — recusando.`);
  process.exit(1);
}

const statements = readFileSync(SQL_PATH, 'utf8')
  .split(/^--\s*@@SPLIT\s*$/m)
  .map((s) => s.trim())
  .filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s));

// Gate de segurança: a garantia central do plano é que a tabela dos leads não é
// alterada. Aqui isso é verificado em CÓDIGO, não confiado ao revisor. Comentários
// são removidos antes da checagem — senão o próprio texto explicativo dispara.
const semComentarios = statements.map((s) => s.replace(/--[^\n]*/g, ''));
const violacoes = semComentarios.filter((s) => /ALTER\s+TABLE\s+"Lead"/i.test(s));
if (violacoes.length > 0) {
  console.error('ABORTADO: a migration tentaria alterar a tabela "Lead".');
  console.error(violacoes.join('\n---\n'));
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

async function contar(tabela) {
  try {
    const r = await prisma.$queryRawUnsafe(`SELECT count(*)::bigint AS n FROM "${tabela}"`);
    return num(r[0].n);
  } catch {
    return null; // tabela ainda não existe
  }
}

const TABELAS = ['Lead', 'Tenant', 'CustomFieldDef', 'CustomFieldGroup', 'Contact', 'Company', 'LeadContact'];

try {
  console.log(`Conectando pela DIRECT_URL (${url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@')})`);
  console.log(`${statements.length} statements a aplicar.\n`);

  const antes = {};
  for (const t of TABELAS) antes[t] = await contar(t);
  console.log('ANTES:', antes);

  if (dryRun) {
    console.log('\n--dry-run: nada foi aplicado.');
    process.exit(0);
  }

  // Tudo ou nada.
  await prisma.$transaction(statements.map((s) => prisma.$executeRawUnsafe(s)));

  const depois = {};
  for (const t of TABELAS) depois[t] = await contar(t);
  console.log('DEPOIS:', depois);

  const problemas = [];
  if (antes.Lead !== depois.Lead) problemas.push(`Lead mudou de ${antes.Lead} para ${depois.Lead}`);
  if (antes.Tenant !== depois.Tenant) problemas.push(`Tenant mudou de ${antes.Tenant} para ${depois.Tenant}`);
  if (antes.CustomFieldDef !== depois.CustomFieldDef) {
    problemas.push(`CustomFieldDef mudou de ${antes.CustomFieldDef} para ${depois.CustomFieldDef}`);
  }
  for (const t of ['Contact', 'Company', 'LeadContact', 'CustomFieldGroup']) {
    if (depois[t] === null) problemas.push(`${t} não foi criada`);
    else if (depois[t] !== 0) problemas.push(`${t} deveria nascer vazia, veio com ${depois[t]}`);
  }

  const escopos = await prisma.$queryRawUnsafe(
    `SELECT escopo::text AS escopo, count(*)::bigint AS n FROM "CustomFieldDef" GROUP BY escopo`,
  );
  console.log('Escopos em CustomFieldDef:', escopos.map((r) => `${r.escopo}=${num(r.n)}`).join(', ') || '(vazio)');
  for (const r of escopos) {
    if (r.escopo !== 'LEAD') problemas.push(`CustomFieldDef caiu em escopo ${r.escopo}, esperado só LEAD`);
  }

  if (problemas.length > 0) {
    console.error('\nDIVERGÊNCIAS:');
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nOK — nenhum lead tocado, tabelas novas criadas e vazias.');
} finally {
  await prisma.$disconnect();
}
