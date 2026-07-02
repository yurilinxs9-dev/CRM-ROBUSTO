/* eslint-disable */
// Normalização FINAL do lead_scope: todo lead passa a lead_scope = tenant_id.
// Pré-requisito: merge-dup-leads.cjs já aplicado (sem grupos telefone+pipeline
// duplicados), senão o UPDATE colide no unique telefone_pipeline_scope.
//
// Segurança: antes de aplicar, detecta colisões potenciais (par telefone+pipeline
// que ficaria duplicado após o UPDATE) e aborta listando-as.
//
// DRY-RUN por padrão. Aplicar: APPLY=1 node scripts/normalize-lead-scope.cjs
require('dotenv').config({ path: 'apps/api/.env' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const APPLY = process.env.APPLY === '1';

(async () => {
  const [{ c: misCount }] = await p.$queryRawUnsafe(
    `SELECT count(*)::int c FROM "Lead" WHERE lead_scope <> tenant_id`,
  );
  console.log(`leads com scope antigo (user-scoped): ${misCount}`);

  // Colisão: dois leads mesmo (telefone, pipeline) que após normalizar teriam
  // o mesmo scope. NULL telefone não colide (Postgres trata NULLs distintos).
  const collisions = await p.$queryRawUnsafe(`
    SELECT tenant_id, telefone, pipeline_id, count(*)::int n
    FROM "Lead" WHERE telefone IS NOT NULL
    GROUP BY 1,2,3 HAVING count(*) > 1`);
  if (collisions.length > 0) {
    console.log(`ABORT: ${collisions.length} grupos ainda duplicados — rode merge-dup-leads.cjs antes`);
    collisions.slice(0, 10).forEach((c) => console.log(`  tel=${c.telefone} pipe=${c.pipeline_id} n=${c.n}`));
    process.exit(1);
  }
  console.log('zero colisões — seguro normalizar');

  if (APPLY) {
    const updated = await p.$executeRawUnsafe(
      `UPDATE "Lead" SET lead_scope = tenant_id WHERE lead_scope <> tenant_id`,
    );
    console.log(`APLICADO: ${updated} leads normalizados`);
    const [{ c: remaining }] = await p.$queryRawUnsafe(
      `SELECT count(*)::int c FROM "Lead" WHERE lead_scope <> tenant_id`,
    );
    console.log(`restantes com scope antigo: ${remaining}`);
  } else {
    console.log('\n>> DRY-RUN. Aplicar: APPLY=1 node scripts/normalize-lead-scope.cjs');
  }
  await p.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
