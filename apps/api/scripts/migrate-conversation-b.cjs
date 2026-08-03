// FASE B: backfill das conversas a partir do histórico de mensagens.
// Idempotente — pode rodar quantas vezes for preciso.
//
//   node scripts/migrate-conversation-b.cjs --dry-run
//   node scripts/migrate-conversation-b.cjs --tenant=<id>
//   node scripts/migrate-conversation-b.cjs            (todos os tenants)
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const baseUrl =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
// O pool do Prisma expira em 10s por padrão ao pedir conexão. Os lotes de
// UPDATE demoram mais que isso, então a chamada seguinte estourava com
// "Timed out fetching a new connection from the connection pool".
// Uma conexão só basta — o script é estritamente sequencial.
const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=300`;
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

const DRY = process.argv.includes('--dry-run');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT = tenantArg ? tenantArg.split('=')[1] : null;
const tenantFilter = TENANT ? `AND l.tenant_id = '${TENANT}'` : '';

(async () => {
  console.log(DRY ? '=== DRY-RUN (nada é escrito) ===' : '=== APLICANDO ===');
  if (TENANT) console.log('tenant:', TENANT);

  // O pooler do Supabase impõe statement_timeout de 2min. A prévia do item 4
  // (GROUP BY + count(DISTINCT) sobre ~246k mensagens, sem filtro de tenant)
  // estoura esse limite e aborta o script ANTES de qualquer escrita. Ampliar
  // só nesta sessão — não altera a configuração do banco.
  await x(`SET statement_timeout = '15min'`);
  const st = await q(`SHOW statement_timeout`);
  console.log(`statement_timeout desta sessão: ${st[0].statement_timeout}`);

  // 1. Quantas conversas serão criadas: um par (lead, instância) por
  //    instance_name distinto nas mensagens do lead.
  const previewMsg = await q(`
    SELECT count(*)::int n FROM (
      SELECT m.lead_id, m.instance_name
      FROM "Message" m JOIN "Lead" l ON l.id = m.lead_id
      WHERE m.instance_name IS NOT NULL ${tenantFilter}
      GROUP BY 1, 2
    ) t`);
  console.log(`conversas a partir de mensagens: ${previewMsg[0].n}`);

  // 2. Leads sem mensagem nenhuma: conversa a partir de lead.instancia_whatsapp.
  const previewLead = await q(`
    SELECT count(*)::int n FROM "Lead" l
    WHERE l.instancia_whatsapp IS NOT NULL AND l.instancia_whatsapp <> ''
      AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m.lead_id = l.id)
      ${tenantFilter}`);
  console.log(`conversas a partir de leads sem mensagem: ${previewLead[0].n}`);

  const orphans = await q(`
    SELECT count(*)::int n FROM "Message" m JOIN "Lead" l ON l.id = m.lead_id
    WHERE m.instance_name IS NULL ${tenantFilter}`);
  console.log(`mensagens sem instance_name (ficarão órfãs): ${orphans[0].n}`);

  // 4 (extra, só leitura). Leads que ficariam com mais de uma conversa —
  // mesma definição usada na medição de blast radius: leads cujas mensagens
  // (com instance_name preenchido) cobrem mais de uma instância distinta.
  // Calculado antes de qualquer escrita, a partir de "Message"/"Lead" apenas.
  const multiPreview = await q(`
    SELECT count(*)::int n FROM (
      SELECT m.lead_id
      FROM "Message" m JOIN "Lead" l ON l.id = m.lead_id
      WHERE m.instance_name IS NOT NULL ${tenantFilter}
      GROUP BY m.lead_id
      HAVING count(DISTINCT m.instance_name) > 1
    ) t`);
  console.log(
    `leads que ficariam com mais de uma conversa (previsão, leitura apenas): ${multiPreview[0].n}`,
  );

  if (DRY) {
    console.log('=== DRY-RUN: nada escrito ===');
    await p.$disconnect();
    return;
  }

  // 3. Cria as conversas a partir das mensagens.
  //    responsavel_id: a conversa que casa com lead.instancia_whatsapp herda
  //    lead.responsavel_id; as demais herdam o owner da instância.
  const created = await x(`
    INSERT INTO "Conversation" (
      id, lead_id, instancia_whatsapp, responsavel_id, status,
      last_customer_message_at, last_message_at, assumed_at, ai_blocked,
      tenant_id, created_at, updated_at
    )
    SELECT
      gen_random_uuid()::text,
      s.lead_id,
      s.instance_name,
      CASE WHEN s.instance_name = l.instancia_whatsapp
           THEN l.responsavel_id ELSE i.owner_user_id END,
      COALESCE(l.atendimento_status, 'OPEN'),
      s.last_customer_at,
      s.last_at,
      CASE WHEN s.instance_name = l.instancia_whatsapp THEN l.assumed_at END,
      CASE WHEN s.instance_name = l.instancia_whatsapp
           THEN COALESCE(l.ai_blocked, false) ELSE false END,
      l.tenant_id,
      s.first_at,
      CURRENT_TIMESTAMP
    FROM (
      SELECT m.lead_id, m.instance_name,
             max(m.created_at) FILTER (WHERE m.direction = 'INCOMING') AS last_customer_at,
             max(m.created_at) AS last_at,
             min(m.created_at) AS first_at
      FROM "Message" m
      WHERE m.instance_name IS NOT NULL
      GROUP BY 1, 2
    ) s
    JOIN "Lead" l ON l.id = s.lead_id
    LEFT JOIN "WhatsappInstance" i
      ON i.nome = s.instance_name AND i.tenant_id = l.tenant_id
    WHERE TRUE ${tenantFilter}
    ON CONFLICT (lead_id, instancia_whatsapp) DO NOTHING`);
  console.log(`conversas criadas a partir de mensagens: ${created}`);

  // 4. Leads sem mensagem.
  const createdLeads = await x(`
    INSERT INTO "Conversation" (
      id, lead_id, instancia_whatsapp, responsavel_id, status,
      last_message_at, assumed_at, ai_blocked, tenant_id, created_at, updated_at
    )
    SELECT gen_random_uuid()::text, l.id, l.instancia_whatsapp, l.responsavel_id,
           COALESCE(l.atendimento_status, 'OPEN'), l.ultima_interacao, l.assumed_at,
           COALESCE(l.ai_blocked, false), l.tenant_id, l.created_at, CURRENT_TIMESTAMP
    FROM "Lead" l
    WHERE l.instancia_whatsapp IS NOT NULL AND l.instancia_whatsapp <> ''
      AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m.lead_id = l.id)
      ${tenantFilter}
    ON CONFLICT (lead_id, instancia_whatsapp) DO NOTHING`);
  console.log(`conversas criadas a partir de leads sem mensagem: ${createdLeads}`);

  // 5. Vincula as mensagens, em lotes de 20k para não segurar lock longo.
  //
  // O lote SÓ pode conter mensagens que já têm conversa correspondente. Uma
  // versão anterior sorteava 20k mensagens de toda a base sem essa junção e sem
  // filtro de tenant: rodando com --tenant, só existem conversas daquele tenant,
  // então um lote podia vir inteiro de outros tenants, o UPDATE afetava 0 linhas,
  // o laço lia isso como "acabou" e encerrava declarando sucesso com as mensagens
  // do tenant alvo ainda sem vincular.
  let total = 0;
  for (;;) {
    const n = await x(`
      UPDATE "Message" m SET conversation_id = c.id
      FROM "Conversation" c
      WHERE c.lead_id = m.lead_id
        AND c.instancia_whatsapp = m.instance_name
        AND m.conversation_id IS NULL
        AND m.id IN (
          SELECT m2.id FROM "Message" m2
          JOIN "Conversation" c2
            ON c2.lead_id = m2.lead_id
           AND c2.instancia_whatsapp = m2.instance_name
          WHERE m2.conversation_id IS NULL
          LIMIT 5000
        )`);
    total += n;
    console.log(`  lote: ${n} mensagens vinculadas (acumulado ${total})`);
    if (n === 0) break;
  }

  // 6. Relatório final.
  const rest = await q(`
    SELECT count(*)::int n FROM "Message" WHERE conversation_id IS NULL`);
  console.log(`mensagens ainda sem conversation_id: ${rest[0].n}`);
  const multi = await q(`
    SELECT count(*)::int n FROM (
      SELECT lead_id FROM "Conversation" GROUP BY 1 HAVING count(*) > 1
    ) t`);
  console.log(`leads com mais de uma conversa (os que sofriam espelhamento): ${multi[0].n}`);
  console.log('FASE B OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
