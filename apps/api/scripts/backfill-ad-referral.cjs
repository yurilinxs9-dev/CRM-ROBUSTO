// Copia o anúncio (Click to WhatsApp) de `metadata.raw` para
// `metadata.ad_referral`, salvando o card antes que a poda dos 30 dias
// (DataRetentionService.pruneMessageRawMetadata) leve o `raw` embora.
//
// SÓ ACRESCENTA a chave `ad_referral` via jsonb_set. Não remove, não altera
// `raw` nem qualquer outra chave, não mexe em schema e não toca no cron.
//
// Uso (dentro do container crm-backend, onde o dist e as env vars existem):
//   node /tmp/backfill-ad-referral.cjs                 → simulação, não grava
//   node /tmp/backfill-ad-referral.cjs --apply         → grava
//   node /tmp/backfill-ad-referral.cjs --tenant=ajuru  → limita a um tenant
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

// Mesma funcao que o backend usa em producao — nada de segunda implementacao
// para divergir. Se o dist nao estiver no lugar esperado, o script para.
function loadExtractor() {
  const candidatos = [
    '/app/dist/modules/webhooks/ad-referral',
    require('path').join(__dirname, '..', 'dist', 'modules', 'webhooks', 'ad-referral'),
  ];
  for (const c of candidatos) {
    try {
      const m = require(c);
      if (typeof m.extractAdReferral === 'function') return m.extractAdReferral;
    } catch {
      // tenta o proximo
    }
  }
  console.error('Nao achei o extrator compilado. Rode dentro do container crm-backend.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const TENANT = (process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1];
const BATCH = 500;

(async () => {
  const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!url) {
    console.error('Faltou DATABASE_URL (ou DIRECT_URL).');
    process.exit(1);
  }
  const extractAdReferral = loadExtractor();
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

  // Paginacao por keyset: `id > cursor`. Preciso porque as linhas em que o
  // extrator nao acha nada continuam batendo no filtro — com OFFSET/LIMIT puro
  // elas voltariam para sempre.
  let cursor = '00000000-0000-0000-0000-000000000000';
  let vistos = 0;
  let gravados = 0;
  let semAnuncio = 0;

  for (;;) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, metadata FROM "Message"
        WHERE metadata IS NOT NULL
          AND jsonb_exists(metadata, 'raw')
          AND NOT jsonb_exists(metadata, 'ad_referral')
          AND metadata::text LIKE '%externalAdReply%'
          AND id > $1
          ${tenantId ? 'AND tenant_id = $3' : ''}
        ORDER BY id LIMIT $2`,
      cursor,
      BATCH,
      ...(tenantId ? [tenantId] : []),
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      vistos++;
      cursor = row.id;
      const ad = extractAdReferral(row.metadata);
      if (!ad) {
        semAnuncio++;
        continue;
      }
      if (APPLY) {
        await prisma.$executeRawUnsafe(
          `UPDATE "Message" SET metadata = jsonb_set(metadata, '{ad_referral}', $2::jsonb, true) WHERE id = $1`,
          row.id,
          JSON.stringify(ad),
        );
      }
      gravados++;
    }
    console.log(`  ...${vistos} examinadas, ${gravados} com anuncio`);
  }

  console.log(`\nexaminadas:      ${vistos}`);
  console.log(`com anuncio:     ${gravados}${APPLY ? ' (gravadas)' : ' (seriam gravadas)'}`);
  console.log(`sem anuncio util: ${semAnuncio}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERRO:', String(e).slice(0, 400));
  process.exit(1);
});
