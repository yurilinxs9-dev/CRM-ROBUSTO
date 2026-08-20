// One-off: aplica 20260817000000_lead_attribution (LeadAttribution,
// TrackedClick, AdCampaignLabel, TenantSiteConfig + enum AttributionChannel).
//
// Uso: node scripts/apply-attribution.mjs            (cwd = apps/api)
//      node scripts/apply-attribution.mjs --dry-run  (só confere e mostra)
//
// Mesmo formato de apply-kommo-fields.mjs: lê os statements do próprio
// migration.sql, separados por "-- @@SPLIT", pra não existirem duas cópias da
// DDL que possam divergir.
// `dotenv` é OPCIONAL aqui. Na VPS o deploy roda `npm install --omit=dev` e o
// dotenv só existe como dependência transitiva do @nestjs/config — não vale
// derrubar uma migration por causa de um import que pode não resolver. O
// caminho normal é exportar as variáveis no shell antes de chamar:
//   set -a && . /opt/crm-whatsapp/.env && set +a
try {
  await import('dotenv/config');
} catch {
  /* segue com o que já estiver no ambiente */
}
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
  '20260817000000_lead_attribution',
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
  console.error('DIRECT_URL não aponta para a porta 5432 — recusando.');
  process.exit(1);
}

const statements = readFileSync(SQL_PATH, 'utf8')
  .split(/^--\s*@@SPLIT\s*$/m)
  .map((s) => s.trim())
  .filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s));

// Tabelas que esta migration cria. É a ÚNICA lista que pode aparecer num
// ALTER/CREATE — qualquer outra tabela citada nesse contexto é tabela que já
// existe em produção, e a promessa da feature é não encostar em nenhuma.
const TABELAS_NOVAS = ['LeadAttribution', 'TrackedClick', 'AdCampaignLabel', 'TenantSiteConfig'];

// Gate de segurança verificado em CÓDIGO, não confiado ao revisor. Comentários
// saem antes da checagem — senão o próprio texto explicativo dispara.
const semComentarios = statements.map((s) => s.replace(/--[^\n]*/g, ''));
const violacoes = [];
for (const s of semComentarios) {
  for (const m of s.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi)) {
    if (!TABELAS_NOVAS.includes(m[1])) violacoes.push(`ALTER TABLE "${m[1]}"`);
  }
  // Só DDL de criação nesta migration — nada que apague ou reescreva dado.
  // Os padrões são específicos de propósito: "ON DELETE CASCADE" e
  // "ON UPDATE CASCADE" fazem parte da FK e NÃO podem disparar o gate.
  const destrutivos = [
    /\bDROP\s+(TABLE|TYPE|INDEX|COLUMN|CONSTRAINT|DATABASE|SCHEMA)\b/gi,
    /\bTRUNCATE\b/gi,
    /\bDELETE\s+FROM\b/gi,
    /\bUPDATE\s+"/gi,
  ];
  for (const re of destrutivos) {
    for (const m of s.matchAll(re)) violacoes.push(`statement destrutivo: ${m[0].trim()}`);
  }
}
if (violacoes.length > 0) {
  console.error('ABORTADO: a migration sairia do escopo aditivo.');
  for (const v of new Set(violacoes)) console.error(`  - ${v}`);
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

// "Lead" e "Message" entram na contagem como testemunhas: se a migration
// encostar nelas, o número muda e o script reclama.
const TABELAS = ['Lead', 'Tenant', 'Message', ...TABELAS_NOVAS];

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
  for (const t of ['Lead', 'Tenant', 'Message']) {
    if (antes[t] !== depois[t]) problemas.push(`${t} mudou de ${antes[t]} para ${depois[t]}`);
  }
  for (const t of TABELAS_NOVAS) {
    if (depois[t] === null) problemas.push(`${t} não foi criada`);
    else if (depois[t] !== 0) problemas.push(`${t} deveria nascer vazia, veio com ${depois[t]}`);
  }

  if (problemas.length > 0) {
    console.error('\nDIVERGÊNCIAS:');
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nOK — nenhuma tabela existente tocada, tabelas novas criadas e vazias.');
  console.log('Agora registre a migration como aplicada:');
  console.log(
    '  node ../../node_modules/prisma/build/index.js migrate resolve --applied 20260817000000_lead_attribution',
  );
} finally {
  await prisma.$disconnect();
}
