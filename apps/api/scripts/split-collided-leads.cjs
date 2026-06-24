// FASE 2: separa leads colididos por número (lead_scope = owner da instância).
// Move mensagens de cada número pro lead do dono daquele número.
// Controles via env:
//   DRY=1            -> só relata, não escreve (default)
//   APPLY=1          -> aplica
//   LEAD_ID=<uuid>   -> processa só esse lead (canário)
//   TENANT=<uuid>    -> limita a um tenant (default: todos individuais)
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const env = fs.readFileSync(require('path').join(__dirname, '../.env'), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim();
const prisma = new PrismaClient({ datasources: { db: { url } } });

const DRY = process.env.APPLY !== '1';
const ONLY_LEAD = process.env.LEAD_ID || null;
const ONLY_TENANT = process.env.TENANT || null;

(async () => {
  // tenants individuais (pool_enabled=false). Pool não colide por número.
  const tenants = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Tenant" WHERE pool_enabled=false ${ONLY_TENANT ? `AND id='${ONLY_TENANT}'` : ''}`);
  const tenantIds = tenants.map((t) => t.id);

  // candidatos: leads com mensagens de >1 owner de instância conhecida
  const candidates = await prisma.$queryRawUnsafe(`
    SELECT l.id
    FROM "Lead" l
    JOIN "Message" m ON m.lead_id=l.id
    JOIN "WhatsappInstance" i ON i.nome=m.instance_name AND i.tenant_id=l.tenant_id
    WHERE l.tenant_id = ANY($1::text[]) ${ONLY_LEAD ? `AND l.id='${ONLY_LEAD}'` : ''}
    GROUP BY l.id
    HAVING count(DISTINCT i.owner_user_id) > 1`, tenantIds);

  console.log(`Modo: ${DRY ? 'DRY-RUN (sem escrever)' : 'APPLY'} | candidatos: ${candidates.length}`);
  let totalNewLeads = 0, totalMoved = 0, totalReused = 0, processed = 0;

  for (const { id: leadId } of candidates) {
    const res = await splitOne(leadId);
    totalNewLeads += res.created; totalReused += res.reused; totalMoved += res.moved; processed++;
    if (ONLY_LEAD || processed <= 5 || res.created + res.reused > 0) {
      console.log(`  [${res.nome}] scope-base=${res.baseScope?.slice(0,8)} grupos=${res.groups} criados=${res.created} reusados=${res.reused} msgs_movidas=${res.moved}`);
    }
  }
  console.log(`\nRESUMO: leads processados=${processed} | novos leads=${totalNewLeads} | reusados=${totalReused} | mensagens movidas=${totalMoved}`);
  if (DRY) console.log('DRY-RUN: nada foi escrito. Rode com APPLY=1 para aplicar.');
  await prisma.$disconnect();
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });

async function splitOne(leadId) {
  return prisma.$transaction(async (tx) => {
    const lead = (await tx.$queryRawUnsafe(`SELECT * FROM "Lead" WHERE id=$1`, leadId))[0];
    // mensagens agrupadas por owner do número (instância conhecida)
    const groups = await tx.$queryRawUnsafe(`
      SELECT i.owner_user_id AS scope, count(*)::int n,
             (array_agg(i.nome ORDER BY m.created_at DESC))[1] AS inst
      FROM "Message" m JOIN "WhatsappInstance" i ON i.nome=m.instance_name AND i.tenant_id=$2
      WHERE m.lead_id=$1
      GROUP BY i.owner_user_id`, leadId, lead.tenant_id);

    const out = { nome: lead.nome, baseScope: lead.lead_scope, groups: groups.length, created: 0, reused: 0, moved: 0 };

    for (const g of groups) {
      if (g.scope === lead.lead_scope) continue; // já é o lead correto desse número

      // acha lead destino existente (telefone+pipeline+scope)
      let target = (await tx.$queryRawUnsafe(
        `SELECT id, responsavel_id FROM "Lead" WHERE telefone=$1 AND pipeline_id=$2 AND lead_scope=$3`,
        lead.telefone, lead.pipeline_id, g.scope))[0];

      if (!target) {
        if (!DRY) {
          const created = (await tx.$queryRawUnsafe(`
            INSERT INTO "Lead" (id,nome,telefone,email,origem,temperatura,score,tags,dados_custom,
              instancia_whatsapp,lead_scope,pipeline_id,estagio_id,estagio_entered_at,responsavel_id,
              foto_url,tenant_id,position,created_at,updated_at,is_private,ai_blocked,atendimento_status,mensagens_nao_lidas)
            SELECT gen_random_uuid(), nome, telefone, email, origem, temperatura, 0, tags, dados_custom,
              $3, $2, pipeline_id, estagio_id, now(), $2, foto_url, tenant_id, position, now(), now(),
              false, false, atendimento_status, 0
            FROM "Lead" WHERE id=$1
            RETURNING id, responsavel_id`, leadId, g.scope, g.inst))[0];
          target = created;
        } else {
          target = { id: '(novo)', responsavel_id: g.scope };
        }
        out.created++;
      } else {
        out.reused++;
      }

      // move mensagens desse owner pro lead destino
      if (!DRY) {
        const moved = await tx.$executeRawUnsafe(`
          UPDATE "Message" SET lead_id=$1, visible_to_user_id=$2
          WHERE id IN (
            SELECT m.id FROM "Message" m
            JOIN "WhatsappInstance" i ON i.nome=m.instance_name AND i.tenant_id=$4
            WHERE m.lead_id=$3 AND i.owner_user_id=$5)`,
          target.id, target.responsavel_id || g.scope, leadId, lead.tenant_id, g.scope);
        out.moved += moved;
      } else {
        out.moved += g.n;
      }
    }
    return out;
  }, { timeout: 30000 });
}
