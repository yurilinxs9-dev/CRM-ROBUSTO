/* eslint-disable */
// Snapshot pré-merge: salva todas as linhas afetadas pelos grupos de leads
// duplicados (Lead completo + mapa id->lead_id de Message/LeadActivity/LeadTag/Task)
// pra rollback. Saída: arquivo JSON com timestamp.
require('dotenv').config({ path: 'apps/api/.env' });
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // ids de todos os leads que estão em grupo duplicado (telefone+pipeline+tenant)
  const dupIds = await p.$queryRawUnsafe(`
    SELECT l.id FROM "Lead" l
    JOIN (SELECT tenant_id, telefone, pipeline_id FROM "Lead" WHERE telefone IS NOT NULL
          GROUP BY 1,2,3 HAVING count(*)>1) g
      ON g.tenant_id=l.tenant_id AND g.telefone=l.telefone AND g.pipeline_id=l.pipeline_id`);
  const ids = dupIds.map((r) => r.id);

  const leads = await p.$queryRawUnsafe(`SELECT * FROM "Lead" WHERE id = ANY($1::text[])`, ids);
  const msgs = await p.$queryRawUnsafe(`SELECT id, lead_id FROM "Message" WHERE lead_id = ANY($1::text[])`, ids);
  const acts = await p.$queryRawUnsafe(`SELECT id, lead_id FROM "LeadActivity" WHERE lead_id = ANY($1::text[])`, ids);
  const tags = await p.$queryRawUnsafe(`SELECT id, lead_id FROM "LeadTag" WHERE lead_id = ANY($1::text[])`, ids);
  const tasks = await p.$queryRawUnsafe(`SELECT id, lead_id FROM "Task" WHERE lead_id = ANY($1::text[])`, ids);

  const out = {
    created_at: new Date().toISOString(),
    affected_lead_ids: ids,
    counts: { leads: leads.length, messages: msgs.length, activities: acts.length, tags: tags.length, tasks: tasks.length },
    leads, message_map: msgs, activity_map: acts, tag_map: tags, task_map: tasks,
  };
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = `scripts/snapshot-dup-leads-${ts}.json`;
  fs.writeFileSync(path, JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v)), 'utf8');
  console.log('SNAPSHOT salvo:', path);
  console.log('counts:', JSON.stringify(out.counts));
  await p.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
