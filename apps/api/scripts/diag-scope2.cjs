// READ-ONLY. Índices reais de Lead + papel das instâncias de captação.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const env = fs.readFileSync(require('path').join(__dirname, '../.env'), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() || env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const q = (sql, ...a) => p.$queryRawUnsafe(sql, ...a);
const CAJURU = 'bb4953ac-b37f-4445-81c0-f54508c77141';

(async () => {
  // 1. TODOS os índices de Lead (constraint OU index)
  const idx = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='Lead' ORDER BY indexname`);
  console.log('=== Índices em Lead ===');
  idx.forEach((i) => console.log(`  ${i.indexname}: ${i.indexdef}`));

  // 2. Quantos leads (todo o banco) compartilham telefone+pipeline? (testa se há dedupe)
  const dupAll = await q(`
    SELECT count(*)::int grupos, COALESCE(sum(n-1),0)::int extras FROM (
      SELECT telefone, pipeline_id, count(*) n FROM "Lead" GROUP BY 1,2 HAVING count(*)>1) t`);
  console.log('\nGrupos telefone+pipeline com >1 lead (todo banco):', JSON.stringify(dupAll[0]));

  // 3. Cajuru: instância -> é captação? (recebe e responsável != dono)
  // Distribuição de instance_name nas mensagens, e se outbound (from_me) por instância
  const perInst = await q(`
    SELECT m.instance_name,
           count(*)::int total,
           sum(CASE WHEN m.direcao='ENVIADA' OR m.direcao='OUT' OR m.from_me THEN 1 ELSE 0 END)::int outbound,
           count(DISTINCT m.lead_id)::int leads
    FROM "Message" m JOIN "Lead" l ON l.id=m.lead_id
    WHERE l.tenant_id=$1 GROUP BY m.instance_name ORDER BY total DESC`, CAJURU).catch(async (e) => {
      // fallback se coluna direcao/from_me diferente
      return q(`SELECT m.instance_name, count(*)::int total, count(DISTINCT m.lead_id)::int leads
        FROM "Message" m JOIN "Lead" l ON l.id=m.lead_id WHERE l.tenant_id=$1
        GROUP BY m.instance_name ORDER BY total DESC`, CAJURU);
    });
  console.log('\n=== Mensagens por instância (Cajuru) ===');
  perInst.forEach((r) => console.log(`  ${r.instance_name}: total=${r.total} ${r.outbound!==undefined?'outbound='+r.outbound:''} leads=${r.leads}`));

  // 4. Colisão SÓ entre números PESSOAIS (exclui atendimento-*)
  const collPersonal = await q(`
    SELECT count(*)::int n FROM (
      SELECT l.id FROM "Lead" l JOIN "Message" m ON m.lead_id=l.id
      JOIN "WhatsappInstance" i ON i.nome=m.instance_name
      WHERE l.tenant_id=$1 AND i.nome NOT ILIKE 'atendimento-%'
      GROUP BY l.id HAVING count(DISTINCT i.owner_user_id)>1) t`, CAJURU);
  console.log('\nLeads colididos SÓ entre números pessoais (exclui captação):', collPersonal[0].n);

  // 5. Colisão considerando captação como neutro: agrupa por owner, mas atendimento-* conta como o responsável
  // Quantos leads têm msgs de >1 número pessoal distinto (operadores diferentes de verdade)
  const realConflict = await q(`
    SELECT l.id, l.nome, ru.nome resp,
      array_agg(DISTINCT i.nome) FILTER (WHERE i.nome NOT ILIKE 'atendimento-%') AS personais
    FROM "Lead" l JOIN "Message" m ON m.lead_id=l.id
    JOIN "WhatsappInstance" i ON i.nome=m.instance_name
    LEFT JOIN "User" ru ON ru.id=l.responsavel_id
    WHERE l.tenant_id=$1
    GROUP BY l.id, l.nome, ru.nome
    HAVING count(DISTINCT i.owner_user_id) FILTER (WHERE i.nome NOT ILIKE 'atendimento-%') > 1
    ORDER BY l.nome`, CAJURU);
  console.log(`\n=== Leads com msgs de 2+ números PESSOAIS distintos (conflito real operador-operador): ${realConflict.length} ===`);
  realConflict.slice(0, 25).forEach((r) => console.log(`  ${r.nome} resp=${r.resp} personais=${JSON.stringify(r.personais)}`));

  await p.$disconnect();
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
