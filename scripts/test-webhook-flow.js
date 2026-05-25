const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const p = new PrismaClient();

(async () => {
  // 1. Pick first SUPER_ADMIN
  const user = await p.user.findFirst({
    where: { role: 'SUPER_ADMIN', ativo: true },
    select: { id: true, email: true, role: true, ativo: true, nome: true, tenant_id: true },
  });
  console.log('User:', user.email, '| tenant:', user.tenant_id);

  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing');

  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
    secret,
    { expiresIn: '5m' },
  );
  console.log('JWT len:', token.length);

  const API = 'http://localhost:3001/api/outbound-webhooks';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // 2. Create webhook (httpbin echoes POST body)
  const createRes = await fetch(API, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Teste automatizado httpbin',
      url: 'https://httpbin.org/post',
      events: ['message.created', 'lead.created', 'lead.updated', 'deal.won', 'deal.lost'],
      active: true,
      secret: 'meu-secret-teste-123',
    }),
  });
  const wh = await createRes.json();
  console.log('Create status:', createRes.status, '| webhook ID:', wh.id);
  if (!wh.id) { console.log('Body:', JSON.stringify(wh)); return; }

  // 3. Trigger test
  const testRes = await fetch(`${API}/${wh.id}/test`, { method: 'POST', headers });
  console.log('Test status:', testRes.status, await testRes.text());

  // 4. Wait + fetch deliveries
  await new Promise(r => setTimeout(r, 6000));
  const delRes = await fetch(`${API}/${wh.id}/deliveries`, { headers });
  const deliveries = await delRes.json();
  console.log('=== DELIVERIES ===');
  console.log(JSON.stringify(deliveries.map(d => ({
    event: d.event_type, status: d.status_code, success: d.success,
    error: d.error, duration_ms: d.duration_ms, attempt: d.attempt,
  })), null, 2));

  // 5. Cleanup
  const delWh = await fetch(`${API}/${wh.id}`, { method: 'DELETE', headers });
  console.log('Delete status:', delWh.status);

  await p.$disconnect();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
