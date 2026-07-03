/* eslint-disable */
// Teste E2E do fix LID: cria Message + job send-text na fila real (pipeline
// completo: processor → resolveRecipient → Evolution). Alvo = lead de teste
// (nosso número) no tenant diplapel. Roda dentro do crm-backend.
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');
const p = new PrismaClient();
const TENANT = '7a7979a2-4b72-4310-a94b-38d83e5433ea';
const TEST_PHONE = '553799191825';

(async () => {
  const lead = await p.lead.findFirst({ where: { tenant_id: TENANT, telefone: TEST_PHONE } });
  if (!lead) throw new Error('lead de teste não encontrado');
  console.log(`lead=${lead.id} telefone=${lead.telefone} whatsapp_lid=${lead.whatsapp_lid}`);

  const inst = await p.whatsappInstance.findFirst({ where: { tenant_id: TENANT } });
  console.log(`instance=${inst.nome} config=${JSON.stringify(inst.config)}`);
  const cfg = inst.config || {};
  if (cfg.provider !== 'evolution') throw new Error('provider inesperado: ' + cfg.provider);

  const msg = await p.message.create({
    data: {
      lead_id: lead.id, tenant_id: TENANT, direction: 'OUTGOING', type: 'TEXT',
      instance_name: inst.nome,
      content: 'teste fix lid (pipeline CRM) - ignorar', status: 'PENDING', sender_type: 'system',
    },
  });
  console.log(`message=${msg.id}`);

  const q = new Queue('messages-send', { connection: { host: process.env.REDIS_HOST || 'crm-redis', port: 6379 } });
  await q.add('send-text', {
    kind: 'text', messageId: msg.id, leadId: lead.id, tenantId: TENANT,
    instanceName: inst.nome, telefone: lead.telefone,
    provider: 'evolution',
    evoBaseUrl: process.env.EVOLUTION_BASE_URL,
    evoApiKey: cfg.evolution_token,
    content: 'teste fix lid (pipeline CRM) - ignorar',
  });
  console.log('job enfileirado; aguardando 15s...');
  await new Promise(r => setTimeout(r, 15000));

  const after = await p.message.findUnique({ where: { id: msg.id }, select: { status: true, whatsapp_message_id: true, metadata: true } });
  console.log(`RESULTADO: status=${after.status} wamid=${after.whatsapp_message_id} meta=${JSON.stringify(after.metadata)}`);
  await q.close();
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
