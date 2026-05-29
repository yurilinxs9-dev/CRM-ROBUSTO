require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  // Leads cujo sufixo de 8 dígitos do telefone coincide mas a string difere
  // (sintoma de duplicata por 9º dígito / formatação).
  const rows = await p.$queryRawUnsafe(`
    SELECT right(regexp_replace(telefone,'\\D','','g'),8) AS suf,
           tenant_id,
           count(*)::int AS n,
           array_agg(DISTINCT telefone) AS fones
    FROM "Lead"
    GROUP BY 1,2
    HAVING count(*) > 1
    ORDER BY n DESC
    LIMIT 15`);
  const totalDup = await p.$queryRawUnsafe(`
    SELECT count(*)::int AS grupos, COALESCE(sum(n-1),0)::int AS leads_extras FROM (
      SELECT right(regexp_replace(telefone,'\\D','','g'),8) AS suf, tenant_id, count(*) AS n
      FROM "Lead" GROUP BY 1,2 HAVING count(*) > 1
    ) t`);
  console.log('=== Grupos de leads duplicados (mesmo sufixo 8 díg, telefone difere) ===');
  console.log('grupos:', totalDup[0].grupos, '| leads extras (duplicados):', totalDup[0].leads_extras);
  console.log('--- amostra ---');
  rows.forEach((r) => console.log(`suf=${r.suf} n=${r.n} fones=${JSON.stringify(r.fones)}`));
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
