/* eslint-disable */
// Merge de leads duplicados (mesmo telefone+pipeline no tenant) gerados pelo
// lead_scope antigo (por dono de instância). Pós-fix: lead_scope = tenant_id.
//
// Sobrevivente: prioriza quem TEM responsável; depois ultima_interacao mais
// recente; depois created_at. Filhos (Message/LeadActivity/LeadTag/Task) migram
// pro sobrevivente, tratando conflito de unique (wamid por tenant, tag por lead).
// Sobrevivente recebe lead_scope = tenant_id.
//
// DRY-RUN por padrão. Aplicar: APPLY=1 node scripts/merge-dup-leads.cjs
require('dotenv').config({ path: 'apps/api/.env' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const APPLY = process.env.APPLY === '1';

(async () => {
  const groups = await p.$queryRawUnsafe(`
    SELECT tenant_id, telefone, pipeline_id, array_agg(id) ids
    FROM "Lead" WHERE telefone IS NOT NULL
    GROUP BY 1,2,3 HAVING count(*)>1`);

  let totalLosers = 0, mMsg = 0, mAct = 0, mTag = 0, mTask = 0, delMsg = 0, delTag = 0, done = 0;
  const samples = [];

  for (const g of groups) {
    // Re-busca membros FRESH por chave do grupo (inclui leads tenant-scoped
    // criados por inbound durante o run). Survivor: prefere quem JÁ está
    // tenant-scoped (canônico), depois com responsável, depois mais recente.
    const rows = await p.$queryRawUnsafe(
      `SELECT id, lead_scope, responsavel_id, ultima_interacao, created_at
       FROM "Lead" WHERE tenant_id=$1 AND telefone=$2 AND pipeline_id=$3
       ORDER BY (lead_scope = tenant_id) DESC, (responsavel_id IS NOT NULL) DESC, ultima_interacao DESC NULLS LAST, created_at DESC`,
      g.tenant_id, g.telefone, g.pipeline_id,
    );
    if (rows.length < 2) continue; // já resolvido por execução anterior
    const survivor = rows[0].id;
    const survivorScope = rows[0].lead_scope;
    const losers = rows.slice(1).map((r) => r.id);
    totalLosers += losers.length;

    if (samples.length < 6) {
      samples.push(`  tel=${g.telefone} manter=${survivor.slice(0,8)}(resp=${rows[0].responsavel_id?'sim':'nao'}) remover=${losers.length}`);
    }

    for (const loser of losers) {
      // contagens (dry-run reporta; apply executa)
      const [[msgMove], [msgConf], [tagMove], [tagConf], [actC], [taskC]] = await Promise.all([
        p.$queryRawUnsafe(`SELECT count(*) c FROM "Message" m WHERE lead_id=$1 AND (whatsapp_message_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Message" s WHERE s.lead_id=$2 AND s.whatsapp_message_id=m.whatsapp_message_id))`, loser, survivor),
        p.$queryRawUnsafe(`SELECT count(*) c FROM "Message" m WHERE lead_id=$1 AND whatsapp_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM "Message" s WHERE s.lead_id=$2 AND s.whatsapp_message_id=m.whatsapp_message_id)`, loser, survivor),
        p.$queryRawUnsafe(`SELECT count(*) c FROM "LeadTag" l WHERE lead_id=$1 AND NOT EXISTS (SELECT 1 FROM "LeadTag" s WHERE s.lead_id=$2 AND s.tag_id=l.tag_id)`, loser, survivor),
        p.$queryRawUnsafe(`SELECT count(*) c FROM "LeadTag" l WHERE lead_id=$1 AND EXISTS (SELECT 1 FROM "LeadTag" s WHERE s.lead_id=$2 AND s.tag_id=l.tag_id)`, loser, survivor),
        p.$queryRawUnsafe(`SELECT count(*) c FROM "LeadActivity" WHERE lead_id=$1`, loser),
        p.$queryRawUnsafe(`SELECT count(*) c FROM "Task" WHERE lead_id=$1`, loser),
      ]);
      mMsg += Number(msgMove.c); delMsg += Number(msgConf.c);
      mTag += Number(tagMove.c); delTag += Number(tagConf.c);
      mAct += Number(actC.c); mTask += Number(taskC.c);

      if (APPLY) {
        await p.$transaction([
          // Message: apaga duplicatas por wamid já no sobrevivente, move o resto
          p.$executeRawUnsafe(`DELETE FROM "Message" m WHERE lead_id=$1 AND whatsapp_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM "Message" s WHERE s.lead_id=$2 AND s.whatsapp_message_id=m.whatsapp_message_id)`, loser, survivor),
          p.$executeRawUnsafe(`UPDATE "Message" SET lead_id=$2 WHERE lead_id=$1`, loser, survivor),
          // LeadTag: apaga tag já existente no sobrevivente, move o resto
          p.$executeRawUnsafe(`DELETE FROM "LeadTag" l WHERE lead_id=$1 AND EXISTS (SELECT 1 FROM "LeadTag" s WHERE s.lead_id=$2 AND s.tag_id=l.tag_id)`, loser, survivor),
          p.$executeRawUnsafe(`UPDATE "LeadTag" SET lead_id=$2 WHERE lead_id=$1`, loser, survivor),
          p.$executeRawUnsafe(`UPDATE "LeadActivity" SET lead_id=$2 WHERE lead_id=$1`, loser, survivor),
          p.$executeRawUnsafe(`UPDATE "Task" SET lead_id=$2 WHERE lead_id=$1`, loser, survivor),
          p.$executeRawUnsafe(`DELETE FROM "Lead" WHERE id=$1`, loser),
        ]);
      }
    }
    if (APPLY && survivorScope !== g.tenant_id) {
      // Seguro: todos os homônimos (rows) ou viraram survivor ou foram deletados.
      await p.$executeRawUnsafe(`UPDATE "Lead" SET lead_scope = tenant_id WHERE id=$1`, survivor);
    }
    done++;
  }

  console.log(`\n=== ${APPLY ? 'APLICADO' : 'DRY-RUN'} ===`);
  console.log(`grupos: ${groups.length} | leads removidos: ${totalLosers}`);
  console.log(`Message: mover ${mMsg}, apagar duplicata ${delMsg}`);
  console.log(`LeadTag: mover ${mTag}, apagar duplicata ${delTag}`);
  console.log(`LeadActivity mover: ${mAct} | Task mover: ${mTask}`);
  console.log('amostras:'); samples.forEach((s) => console.log(s));
  if (!APPLY) console.log('\n>> revisar e rodar com APPLY=1 pra aplicar');
  await p.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
