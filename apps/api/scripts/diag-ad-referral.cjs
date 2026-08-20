// READ-ONLY. Diagnóstico do card de anúncio (Click to WhatsApp) na Cajuru
// Interiores: o payload `externalAdReply` está chegando e sendo salvo em
// `Message.metadata.raw`? Ver docs/specs/anuncio-na-conversa.md.
//
// Uso: cd apps/api && node scripts/diag-ad-referral.cjs [nome-do-lead]
// Não escreve nada no banco.
// Roda em dois lugares: na maquina de dev (le apps/api/.env ou o .env da raiz)
// e dentro do container crm-backend no VPS, onde as variaveis ja vem do
// compose e nao ha nem arquivo .env nem dotenv garantido no node_modules.
try {
  const path = require('path');
  for (const p of [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ]) {
    require('dotenv').config({ path: p });
  }
} catch {
  // Sem dotenv: no container as variaveis ja estao no ambiente.
}
const { PrismaClient } = require('@prisma/client');

// Aceita as duas: alguns .env desta stack tem so DIRECT_URL (o pooler do
// Supabase serve igual pra leitura). Sem nenhuma das duas, avisa em vez de
// estourar um erro de conexao opaco.
const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) {
  console.error('Faltou DATABASE_URL (ou DIRECT_URL) em apps/api/.env — nada a consultar.');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

const LEAD_ARG = process.argv[2] || 'Ilda';
const AD_KEY = 'externalAdReply';

/** Caminho onde o objeto do anúncio aparece, pra saber se é caminho conhecido. */
function findAdPath(node, path = [], depth = 0) {
  if (depth > 10 || node === null || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (k === AD_KEY && v && typeof v === 'object') return { path: [...path, k], ad: v };
    const hit = findAdPath(v, [...path, k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Descreve o thumbnail sem despejar os bytes no terminal. */
function describeThumb(v) {
  if (v === undefined) return 'ausente';
  if (typeof v === 'string') return `string base64 (${v.length} chars)`;
  if (Array.isArray(v)) return `array de ${v.length} bytes`;
  if (v && typeof v === 'object') return `byte-map de ${Object.keys(v).length} bytes`;
  return typeof v;
}

(async () => {
  const tenant = await prisma.tenant.findFirst({
    where: { nome: { contains: 'ajuru', mode: 'insensitive' } },
    select: { id: true, nome: true },
  });
  if (!tenant) {
    console.log('tenant Cajuru nao encontrado');
    process.exit(1);
  }
  console.log(`tenant: ${tenant.nome} (${tenant.id})\n`);

  // 1. Provider de cada instância — a forma do payload muda por provider.
  const instances = await prisma.whatsappInstance.findMany({
    where: { tenant_id: tenant.id },
    select: { nome: true, status: true, config: true },
  });
  console.log('--- INSTANCIAS ---');
  for (const i of instances) {
    const provider = (i.config && i.config.provider) || 'uazapi (default)';
    console.log(`  ${i.nome.padEnd(24)} provider=${String(provider).padEnd(12)} status=${i.status}`);
  }

  // 2. O payload do anúncio chega neste tenant?
  const [totalIn] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Message" WHERE tenant_id = $1 AND direction = 'INCOMING'`,
    tenant.id,
  );
  const comAd = await prisma.$queryRawUnsafe(
    `SELECT instance_name, COUNT(*)::int AS n, MAX(created_at) AS ultima
       FROM "Message"
      WHERE tenant_id = $1 AND direction = 'INCOMING'
        AND metadata::text LIKE '%${AD_KEY}%'
      GROUP BY instance_name ORDER BY n DESC`,
    tenant.id,
  );
  const [comCtx] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Message"
      WHERE tenant_id = $1 AND direction = 'INCOMING' AND metadata::text LIKE '%contextInfo%'`,
    tenant.id,
  );

  console.log(`\n--- PAYLOAD DE ANUNCIO NO TENANT ---`);
  console.log(`  mensagens INCOMING no total:        ${totalIn.n}`);
  console.log(`  com "contextInfo" no metadata:      ${comCtx.n}`);
  console.log(`  com "${AD_KEY}" no metadata: ${comAd.reduce((s, r) => s + r.n, 0)}`);
  for (const r of comAd) {
    console.log(`      ${r.instance_name.padEnd(24)} ${String(r.n).padStart(4)}  ultima: ${r.ultima.toISOString().slice(0, 10)}`);
  }
  if (comAd.length === 0) {
    console.log('      NENHUMA — o provider nao esta repassando o bloco do anuncio.');
  }

  // 3. O lead da print: a primeira mensagem dele tem o anúncio?
  const leads = await prisma.lead.findMany({
    where: { tenant_id: tenant.id, nome: { contains: LEAD_ARG, mode: 'insensitive' } },
    select: { id: true, nome: true, telefone: true, instancia_whatsapp: true, created_at: true },
    orderBy: { created_at: 'desc' },
    take: 5,
  });
  console.log(`\n--- LEAD "${LEAD_ARG}" (${leads.length} encontrado(s)) ---`);
  for (const lead of leads) {
    console.log(`\n  ${lead.nome} | ${lead.telefone} | ${lead.instancia_whatsapp} | criado ${lead.created_at.toISOString().slice(0, 16)}`);
    const first = await prisma.message.findFirst({
      where: { lead_id: lead.id, direction: 'INCOMING' },
      orderBy: { created_at: 'asc' },
      select: { id: true, content: true, metadata: true, created_at: true },
    });
    if (!first) {
      console.log('    sem mensagem INCOMING');
      continue;
    }
    console.log(`    1a msg: ${JSON.stringify((first.content || '').slice(0, 60))}`);
    const meta = first.metadata;
    if (!meta || typeof meta !== 'object') {
      console.log('    metadata VAZIO — nada a extrair');
      continue;
    }
    const raw = meta.raw;
    console.log(`    metadata.raw: ${raw ? `presente, chaves de topo: ${Object.keys(raw).join(', ')}` : 'AUSENTE'}`);
    const hit = findAdPath(meta);
    if (!hit) {
      console.log(`    ${AD_KEY}: NAO ENCONTRADO neste payload`);
      // Mostra onde ficaria, pra comparar com o que o provider manda.
      const ctx = findAdPathByKey(meta, 'contextInfo');
      console.log(`    contextInfo: ${ctx ? ctx.path.join('.') : 'tambem ausente'}`);
      continue;
    }
    console.log(`    ${AD_KEY}: ENCONTRADO em metadata.${hit.path.join('.')}`);
    const ad = hit.ad;
    console.log(`      campos: ${Object.keys(ad).join(', ')}`);
    for (const k of ['title', 'body', 'sourceApp', 'sourceType', 'sourceUrl', 'sourceURL', 'sourceId', 'sourceID', 'mediaUrl', 'mediaURL', 'thumbnailUrl', 'thumbnailURL', 'ctwaClid']) {
      if (ad[k] !== undefined) console.log(`      ${k} = ${String(ad[k]).slice(0, 90)}`);
    }
    console.log(`      thumbnail: ${describeThumb(ad.thumbnail)}`);
  }
})()
  .catch((e) => console.error('ERRO:', String(e).slice(0, 400)))
  .finally(() => prisma.$disconnect());

/** Igual ao findAdPath, mas procurando uma chave qualquer. */
function findAdPathByKey(node, key, path = [], depth = 0) {
  if (depth > 10 || node === null || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (k === key && v && typeof v === 'object') return { path: [...path, k], ad: v };
    const hit = findAdPathByKey(v, key, [...path, k], depth + 1);
    if (hit) return hit;
  }
  return null;
}
