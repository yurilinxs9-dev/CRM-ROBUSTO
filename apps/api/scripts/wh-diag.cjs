require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [total, unprocessed, withErr, byEvent, recentErrs, msgs24, leads] = await Promise.all([
    p.webhookLog.count({ where: { created_at: { gte: since } } }),
    p.webhookLog.count({ where: { created_at: { gte: since }, processed: false } }),
    p.webhookLog.count({ where: { created_at: { gte: since }, error: { not: null } } }),
    p.webhookLog.groupBy({ by: ['event'], where: { created_at: { gte: since } }, _count: { id: true } }),
    p.webhookLog.findMany({ where: { created_at: { gte: since }, error: { not: null } }, select: { event: true, error: true, created_at: true }, orderBy: { created_at: 'desc' }, take: 8 }),
    p.message.count({ where: { created_at: { gte: since } } }),
    p.lead.count(),
  ]);
  console.log('=== WebhookLog ultimas 24h ===');
  console.log('total:', total, '| nao-processados:', unprocessed, '| com erro:', withErr);
  console.log('por evento:', JSON.stringify(byEvent.map((e) => ({ ev: e.event, n: e._count.id }))));
  console.log('mensagens salvas 24h:', msgs24, '| leads total:', leads);
  console.log('--- amostra erros ---');
  recentErrs.forEach((e) => console.log(e.created_at.toISOString(), '|', e.event, '|', String(e.error).slice(0, 180)));
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
