// READ-ONLY: entende o estado do banco antes de qualquer migration.
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() || env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const prisma = new PrismaClient({ datasources: { db: { url } } });

const q = (sql) => prisma.$queryRawUnsafe(sql);

try {
  const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  const names = tables.map((t) => t.table_name);
  console.log('TOTAL_TABLES:', names.length);

  const crm = ['Tenant', 'Lead', 'Message', 'Pipeline', 'Stage', 'ApiKey', 'Sector', 'User'];
  const evo = names.filter((n) => /integration|flowise|evolution|chatwoot|typebot|dify|pusher|wavoip|openai/i.test(n));
  console.log('CRM_TABLES_PRESENT:', crm.filter((c) => names.includes(c)).join(', ') || 'NENHUMA');
  console.log('AI_NEW_TABLES_PRESENT:', ['AiModelConfig', 'Broadcast', 'BroadcastTarget'].filter((c) => names.includes(c)).join(', ') || 'nenhuma (esperado)');
  console.log('EVOLUTION_LIKE_TABLES:', evo.length, evo.slice(0, 15).join(', '));

  const migs = await q(`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at`);
  console.log('PRISMA_MIGRATIONS_COUNT:', migs.length);
  const crmMig = migs.filter((m) => /init|multi_tenant|sectors|api_keys|platform_admin|pipeline_kommo|outbound_webhooks/i.test(m.migration_name));
  console.log('CRM_MIGRATIONS_RECORDED:', crmMig.length, '→', crmMig.map((m) => m.migration_name).slice(0, 8).join(', '));
  console.log('LAST_5_MIGRATIONS:', migs.slice(-5).map((m) => m.migration_name).join(' | '));
  const unfinished = migs.filter((m) => !m.finished_at);
  console.log('UNFINISHED_MIGRATIONS:', unfinished.length, unfinished.map((m) => m.migration_name).join(', '));
} catch (e) {
  console.error('ERRO:', String(e).slice(0, 300));
} finally {
  await prisma.$disconnect();
}
