/* eslint-disable no-console */
// Dry-run SEGURO da migration F-01/F-03 contra o banco real: roda tudo dentro
// de uma transação e dá ROLLBACK no fim — NADA é persistido. Prova que o SQL
// estrutural aplica sem erro no schema atual de produção.
//
// Pula o `UPDATE "Message"` (backfill numa tabela potencialmente grande) para
// não segurar lock em produção durante o teste. Esse statement é SQL trivial
// (SET sender_type onde sent_by_user_id IS NOT NULL) e será aplicado de fato no
// deploy real.
//
// Uso: ../../node_modules/.bin/ts-node --transpile-only scripts/dryrun-migration.ts
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

function loadDirectUrl(): string {
  const envPath = join(__dirname, '..', '.env');
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^DIRECT_URL=(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('DIRECT_URL não encontrado em .env');
}

function splitStatements(sql: string): string[] {
  // Remove linhas de comentário e divide por ';'. A migration não tem ';'
  // dentro de literais (só 'Sem Setor', 'user', etc — sem ponto-e-vírgula).
  const noComments = sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return noComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  const url = loadDirectUrl();
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  const sqlPath = join(__dirname, '..', 'prisma', 'migrations', '20260611000000_f01f03_sectors_roundrobin_sender', 'migration.sql');
  const statements = splitStatements(readFileSync(sqlPath, 'utf8'));

  let ran = 0;
  let skipped = 0;
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const stmt of statements) {
          if (/UPDATE\s+"Message"/i.test(stmt)) {
            skipped++;
            console.log(`  ⏭  skip (backfill Message, evita lock): ${stmt.slice(0, 60)}…`);
            continue;
          }
          await tx.$executeRawUnsafe(stmt);
          ran++;
          console.log(`  ✓ ${stmt.slice(0, 70).replace(/\s+/g, ' ')}…`);
        }
        // Aborta de propósito — rollback de tudo.
        throw new Error('__DRYRUN_ROLLBACK__');
      },
      { timeout: 120000, maxWait: 10000 },
    );
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('__DRYRUN_ROLLBACK__')) {
      console.log(`\n✅ DRY-RUN OK — ${ran} statements aplicaram sem erro (${skipped} pulados). ROLLBACK feito, nada persistido.`);
      await prisma.$disconnect();
      process.exit(0);
    }
    console.error(`\n❌ DRY-RUN FALHOU: ${msg}`);
    await prisma.$disconnect();
    process.exit(1);
  }
}
main();
