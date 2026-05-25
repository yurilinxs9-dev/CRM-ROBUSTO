const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const h = await p.outboundWebhook.findMany({
    select: { id: true, name: true, url: true, events: true, active: true, secret: true, custom_headers: true, created_at: true },
  });
  console.log('=== WEBHOOKS ===');
  console.log(JSON.stringify(h, null, 2));
  const d = await p.webhookDelivery.findMany({
    orderBy: { created_at: 'desc' },
    take: 15,
    select: { event_type: true, status_code: true, success: true, error: true, duration_ms: true, attempt: true, created_at: true },
  });
  console.log('=== DELIVERIES (15 mais recentes) ===');
  console.log(JSON.stringify(d, null, 2));
  await p.$disconnect();
})();
