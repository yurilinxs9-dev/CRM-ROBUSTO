/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const url = readFileSync(join(__dirname, '..', '.env'), 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('DIRECT_URL='))!
  .slice('DIRECT_URL='.length)
  .trim()
  .replace(/^["']|["']$/g, '');
const p = new PrismaClient({ datasources: { db: { url } } });

(async () => {
  const q = (sql: string) => p.$queryRawUnsafe<{ n: number }[]>(sql).then((r) => r[0].n);
  const sectors = await q(`SELECT count(*)::int n FROM "Sector"`);
  const semSetor = await q(`SELECT count(*)::int n FROM "Sector" WHERE name='Sem Setor'`);
  const usersNull = await q(`SELECT count(*)::int n FROM "User" WHERE sector_id IS NULL`);
  const usersTotal = await q(`SELECT count(*)::int n FROM "User"`);
  const cols = await p.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='Message' AND column_name IN ('sender_type','sender_id')`,
  );
  console.log('Sectors total:', sectors);
  console.log('Setores "Sem Setor":', semSetor);
  console.log('Users sem setor:', usersNull, '/ total', usersTotal);
  console.log('Message novas colunas:', cols.map((c) => c.column_name).join(', '));
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
