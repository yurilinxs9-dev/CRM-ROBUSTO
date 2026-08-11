// Alinha `Lead.position` com a ordem que os cards JÁ aparecem hoje no Kanban
// (última interação primeiro). Sem isto, ao passar a ordenar por `position` o
// board inverteria: as posições gravadas pela regra antiga cresciam com a
// criação, então o lead mais VELHO ficaria no topo.
//
// Seguro rodar ANTES do deploy: hoje `position` é gravada mas nunca usada para
// ordenar, então mexer nela não muda nada na tela até o código novo subir.
//
// Escreve uma coluna, em uma tabela, um estágio por vez. Não altera schema,
// não apaga nada, não toca em nenhum outro campo.
//
// Uso (dentro do container crm-backend):
//   node /tmp/backfill-lead-position.cjs                 → simulação
//   node /tmp/backfill-lead-position.cjs --apply         → grava
//   node /tmp/backfill-lead-position.cjs --tenant=ajuru  → limita a um tenant
try {
  const path = require('path');
  for (const p of [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ]) {
    require('dotenv').config({ path: p });
  }
} catch {
  // No container as variaveis ja vem do compose.
}
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const TENANT = (process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1];

(async () => {
  const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!url) {
    console.error('Faltou DATABASE_URL (ou DIRECT_URL).');
    process.exit(1);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  let tenantId = null;
  if (TENANT) {
    const t = await prisma.tenant.findFirst({
      where: { nome: { contains: TENANT, mode: 'insensitive' } },
      select: { id: true, nome: true },
    });
    if (!t) {
      console.error(`tenant "${TENANT}" nao encontrado`);
      process.exit(1);
    }
    tenantId = t.id;
    console.log(`tenant: ${t.nome}`);
  }

  console.log(APPLY ? 'MODO: gravando' : 'MODO: simulacao (use --apply para gravar)');

  // Um UPDATE por estagio, em vez de um unico na tabela inteira: cada
  // instrucao trava poucas linhas e o progresso fica visivel.
  const stages = await prisma.stage.findMany({
    where: tenantId ? { tenant_id: tenantId } : {},
    select: { id: true, nome: true, tenant_id: true },
  });
  console.log(`estagios: ${stages.length}`);

  let totalLeads = 0;
  let estagiosComLead = 0;

  for (const stage of stages) {
    const n = await prisma.lead.count({ where: { estagio_id: stage.id } });
    if (n === 0) continue;
    estagiosComLead++;
    totalLeads += n;

    if (APPLY) {
      // row_number() sobre a MESMA ordem que a tela usa hoje. O passo de 1000
      // deixa espaco para o usuario arrastar cards entre vizinhos depois.
      await prisma.$executeRawUnsafe(
        `UPDATE "Lead" l
            SET position = o.rn * 1000
           FROM (
             SELECT id, row_number() OVER (
                      ORDER BY ultima_interacao DESC NULLS LAST, created_at DESC
                    ) AS rn
               FROM "Lead"
              WHERE estagio_id = $1::uuid
           ) o
          WHERE o.id = l.id`,
        stage.id,
      );
    }
    console.log(`  ${stage.nome.padEnd(24)} ${String(n).padStart(5)} leads`);
  }

  console.log(`\nestagios com lead: ${estagiosComLead}`);
  console.log(`leads:             ${totalLeads}${APPLY ? ' (reposicionados)' : ' (seriam reposicionados)'}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERRO:', String(e).slice(0, 400));
  process.exit(1);
});
