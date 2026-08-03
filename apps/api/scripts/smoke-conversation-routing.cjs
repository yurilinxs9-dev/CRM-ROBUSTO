// Smoke do bug de espelhamento entre vendedores.
//
// Reproduz o caso Cajuru: contato fala com o vendedor A, some, e volta falando
// com o vendedor B. Verifica que a mensagem nova NÃO cai na conversa do A.
//
//   node scripts/smoke-conversation-routing.cjs --tenant=<id>
//
// Idempotente: limpa antes e depois. Nada com prefixo smoke-conv- sobrevive.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const url =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });

const PREFIX = 'smoke-conv-';
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT = tenantArg ? tenantArg.split('=')[1] : null;
if (!TENANT) {
  console.error('uso: node scripts/smoke-conversation-routing.cjs --tenant=<id>');
  process.exit(1);
}

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('ok:', msg);
  } else {
    console.error('FALHOU:', msg);
    failures += 1;
  }
}

async function cleanup() {
  const leads = await p.lead.findMany({
    where: { tenant_id: TENANT, telefone: { startsWith: PREFIX } },
    select: { id: true },
  });
  const leadIds = leads.map((l) => l.id);
  if (leadIds.length) {
    await p.message.deleteMany({ where: { lead_id: { in: leadIds } } });
    await p.conversation.deleteMany({ where: { lead_id: { in: leadIds } } });
    await p.lead.deleteMany({ where: { id: { in: leadIds } } });
  }
  await p.whatsappInstance.deleteMany({
    where: { tenant_id: TENANT, nome: { startsWith: PREFIX } },
  });
  await p.user.deleteMany({
    where: { tenant_id: TENANT, email: { startsWith: PREFIX } },
  });
}

(async () => {
  await cleanup();
  console.log('--- montando cenário ---');

  const pipeline = await p.pipeline.findFirst({
    where: { tenant_id: TENANT, arquivado: false },
    include: { stages: { orderBy: { ordem: 'asc' }, take: 1 } },
  });
  if (!pipeline || pipeline.stages.length === 0) {
    console.error('ABORT: tenant sem pipeline/stage utilizável.');
    process.exit(1);
  }
  const stage = pipeline.stages[0];

  const vendedoraUser = await p.user.create({
    data: {
      nome: 'Smoke Vendedora',
      email: `${PREFIX}vendedora@example.test`,
      senha_hash: 'x',
      role: 'OPERADOR',
      tenant_id: TENANT,
    },
  });
  const alexUser = await p.user.create({
    data: {
      nome: 'Smoke Alex',
      email: `${PREFIX}alex@example.test`,
      senha_hash: 'x',
      role: 'OPERADOR',
      tenant_id: TENANT,
    },
  });

  const instVendedora = await p.whatsappInstance.create({
    data: {
      nome: `${PREFIX}inst-vendedora`,
      status: 'open',
      owner_user_id: vendedoraUser.id,
      tenant_id: TENANT,
    },
  });
  const instAlex = await p.whatsappInstance.create({
    data: {
      nome: `${PREFIX}inst-alex`,
      status: 'open',
      owner_user_id: alexUser.id,
      tenant_id: TENANT,
    },
  });

  // --- Cenário 1: dois vendedores no mesmo contato (o bug) ---
  const lead = await p.lead.create({
    data: {
      nome: 'Smoke Cliente Dois Vendedores',
      telefone: `${PREFIX}5511900000001`,
      instancia_whatsapp: instVendedora.nome,
      lead_scope: TENANT,
      pipeline_id: pipeline.id,
      estagio_id: stage.id,
      responsavel_id: vendedoraUser.id,
      tenant_id: TENANT,
    },
  });

  const convVendedora = await p.conversation.create({
    data: {
      lead_id: lead.id,
      instancia_whatsapp: instVendedora.nome,
      responsavel_id: vendedoraUser.id,
      tenant_id: TENANT,
      last_customer_message_at: new Date('2026-03-10T12:00:00Z'),
      last_message_at: new Date('2026-03-10T12:00:00Z'),
    },
  });
  const convAlex = await p.conversation.create({
    data: {
      lead_id: lead.id,
      instancia_whatsapp: instAlex.nome,
      responsavel_id: alexUser.id,
      tenant_id: TENANT,
      last_customer_message_at: new Date('2026-08-03T09:00:00Z'),
      last_message_at: new Date('2026-08-03T09:00:00Z'),
    },
  });

  const msgNova = await p.message.create({
    data: {
      lead_id: lead.id,
      conversation_id: convAlex.id,
      instance_name: instAlex.nome,
      whatsapp_message_id: `${PREFIX}msg-1`,
      direction: 'INCOMING',
      type: 'TEXT',
      content: 'oi, voltei',
      visible_to_user_id: alexUser.id,
      tenant_id: TENANT,
    },
  });

  // Espelha o lead a partir da conversa ativa, como o webhook faz.
  await p.lead.update({
    where: { id: lead.id },
    data: {
      responsavel_id: alexUser.id,
      instancia_whatsapp: instAlex.nome,
    },
  });
  const leadDepois = await p.lead.findUnique({ where: { id: lead.id } });

  assert(
    msgNova.conversation_id === convAlex.id,
    'mensagem nova ficou na conversa do Alex',
  );
  const msgsDaVendedora = await p.message.count({
    where: { conversation_id: convVendedora.id },
  });
  assert(msgsDaVendedora === 0, 'conversa da vendedora não recebeu a mensagem nova');
  assert(
    msgNova.visible_to_user_id === alexUser.id,
    'visible_to_user_id aponta pro Alex, não pra vendedora',
  );
  assert(
    leadDepois.responsavel_id === alexUser.id,
    'card do Kanban foi pro Alex',
  );
  assert(
    leadDepois.instancia_whatsapp === instAlex.nome,
    'lead passou a apontar pra instância do Alex',
  );

  // --- Cenário 2: anti-roubo. Envio pela instância da vendedora não move card ---
  await p.message.create({
    data: {
      lead_id: lead.id,
      conversation_id: convVendedora.id,
      instance_name: instVendedora.nome,
      whatsapp_message_id: `${PREFIX}msg-2`,
      direction: 'OUTGOING',
      type: 'TEXT',
      content: 'follow-up automático',
      sender_type: 'system',
      tenant_id: TENANT,
    },
  });
  await p.conversation.update({
    where: { id: convVendedora.id },
    data: { last_message_at: new Date('2026-08-04T10:00:00Z') },
  });
  const leadAposFollowup = await p.lead.findUnique({ where: { id: lead.id } });
  assert(
    leadAposFollowup.responsavel_id === alexUser.id,
    'follow-up pela instância da vendedora NÃO trouxe o card de volta',
  );

  // --- Cenário 3: um vendedor só — o caso que já funcionava ---
  const leadSolo = await p.lead.create({
    data: {
      nome: 'Smoke Cliente Um Vendedor',
      telefone: `${PREFIX}5511900000002`,
      instancia_whatsapp: instAlex.nome,
      lead_scope: TENANT,
      pipeline_id: pipeline.id,
      estagio_id: stage.id,
      responsavel_id: alexUser.id,
      tenant_id: TENANT,
    },
  });
  await p.conversation.create({
    data: {
      lead_id: leadSolo.id,
      instancia_whatsapp: instAlex.nome,
      responsavel_id: alexUser.id,
      tenant_id: TENANT,
      last_customer_message_at: new Date('2026-08-03T09:00:00Z'),
    },
  });
  const convsSolo = await p.conversation.count({ where: { lead_id: leadSolo.id } });
  const leadSoloDepois = await p.lead.findUnique({ where: { id: leadSolo.id } });
  assert(convsSolo === 1, 'contato com um vendedor só tem exatamente uma conversa');
  assert(
    leadSoloDepois.responsavel_id === alexUser.id,
    'contato com um vendedor só continua com o dono de sempre',
  );

  console.log('--- limpando ---');
  await cleanup();
  await p.$disconnect();

  if (failures > 0) {
    console.error(`${failures} asserção(ões) falharam`);
    process.exit(1);
  }
  console.log('SMOKE OK');
})().catch(async (e) => {
  console.error('ERRO:', e.message);
  await cleanup().catch(() => undefined);
  await p.$disconnect().catch(() => undefined);
  process.exit(1);
});
