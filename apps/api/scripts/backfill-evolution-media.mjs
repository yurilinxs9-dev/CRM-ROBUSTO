// FASE 2 do backfill do apagão: baixa da CDN do WhatsApp, descriptografa e
// sobe para o storage os arquivos das mensagens que a fase 1 importou.
//
// A fase 1 (backfill-evolution-gap.mjs) gravou em metadata.backfill_media a URL
// e a mediaKey de cada mídia. Aqui elas viram arquivo de verdade.
//
// RODAR NA VPS:
//   cd /opt/crm-whatsapp/apps/api
//   set -a && . /opt/crm-whatsapp/.env && set +a
//   node scripts/backfill-evolution-media.mjs            # dry-run
//   node scripts/backfill-evolution-media.mjs --apply    # baixa e sobe
//
// RETOMÁVEL: só processa quem ainda está com media_url nulo. Pode interromper
// com Ctrl+C e rodar de novo que continua de onde parou.
//
// Não passa por service nenhum do Nest — mesma regra da fase 1. Escreve direto
// no banco e no storage.
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const LIMITE = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0);
const PARALELO = 6; // baixar 2.4k arquivos em série levaria horas

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'crm-media';

// Idêntico a media-crypto.ts. Reimplementado aqui porque aquele arquivo é TS e
// este script roda direto no node, sem build. Se um dia divergirem, a verdade
// é o media-crypto.ts.
const INFO = {
  IMAGE: 'WhatsApp Image Keys',
  VIDEO: 'WhatsApp Video Keys',
  AUDIO: 'WhatsApp Audio Keys',
  DOCUMENT: 'WhatsApp Document Keys',
  STICKER: 'WhatsApp Image Keys',
};

function descriptografar(cifrado, mediaKeyB64, tipo) {
  const mediaKey = Buffer.from(mediaKeyB64, 'base64');
  const exp = Buffer.from(hkdfSync('sha256', mediaKey, Buffer.alloc(0), INFO[tipo] ?? INFO.DOCUMENT, 112));
  const iv = exp.subarray(0, 16);
  const chave = exp.subarray(16, 48);
  const texto = cifrado.subarray(0, cifrado.length - 10); // últimos 10B = MAC
  const d = createDecipheriv('aes-256-cbc', chave, iv);
  d.setAutoPadding(false);
  const aberto = Buffer.concat([d.update(texto), d.final()]);
  const pad = aberto[aberto.length - 1];
  return pad > 0 && pad <= 16 ? aberto.subarray(0, aberto.length - pad) : aberto;
}

/** Confere os bytes mágicos. Se a descriptografia falhou, o conteúdo é lixo —
 *  melhor deixar a mensagem sem arquivo do que gravar arquivo corrompido. */
function pareceValido(buf, mime) {
  if (buf.length < 12) return false;
  const h = buf.subarray(0, 12);
  const eq = (...b) => b.every((v, i) => h[i] === v);
  const ascii = (s, off = 0) => h.subarray(off, off + s.length).toString('latin1') === s;
  if (mime?.startsWith('image/jpeg')) return eq(0xff, 0xd8, 0xff);
  if (mime?.startsWith('image/png')) return eq(0x89, 0x50, 0x4e, 0x47);
  if (mime?.startsWith('image/webp')) return ascii('RIFF') && ascii('WEBP', 8);
  if (mime?.startsWith('image/gif')) return ascii('GIF8');
  if (mime?.includes('ogg')) return ascii('OggS');
  if (mime?.includes('mp4') || mime?.startsWith('video/')) return ascii('ftyp', 4) || eq(0x00, 0x00, 0x00);
  if (mime?.includes('pdf')) return ascii('%PDF');
  if (mime?.includes('mpeg')) return eq(0xff, 0xfb) || eq(0x49, 0x44, 0x33);
  return true; // tipo que não sei validar: aceita
}

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};
const extDe = (mime) => EXT[(mime ?? '').split(';')[0].trim()] ?? 'bin';

async function subir(caminho, buf, mime) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${caminho}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': mime || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!r.ok) throw new Error(`storage ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

const prisma = new PrismaClient();

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no ambiente.');
    process.exit(1);
  }
  console.log(APPLY ? 'MODO: BAIXANDO E SUBINDO\n' : 'MODO: dry-run (nada será baixado nem gravado)\n');
  console.log(`bucket: ${BUCKET} | paralelismo: ${PARALELO}\n`);

  const pendentes = await prisma.$queryRawUnsafe(`
    SELECT id, tenant_id, whatsapp_message_id AS wa_id, type::text AS tipo,
           media_mimetype AS mime,
           metadata->'backfill_media'->>'url' AS url,
           metadata->'backfill_media'->>'mediaKey' AS chave
      FROM "Message"
     WHERE metadata->>'backfill' = 'true'
       AND metadata->'backfill_media' IS NOT NULL
       AND media_url IS NULL
     ORDER BY created_at
     ${LIMITE ? `LIMIT ${LIMITE}` : ''}`);

  console.log(`${pendentes.length} mídias pendentes.`);
  if (!APPLY) {
    const porTipo = {};
    for (const m of pendentes) porTipo[m.tipo] = (porTipo[m.tipo] ?? 0) + 1;
    console.log('por tipo:', JSON.stringify(porTipo));
    console.log('\n--dry-run: nada foi baixado. Rode com --apply para valer.');
    return;
  }

  const st = { ok: 0, semUrl: 0, download: 0, cripto: 0, invalido: 0, upload: 0 };
  let feitos = 0;
  const fila = [...pendentes];

  async function trabalhador() {
    for (;;) {
      const m = fila.shift();
      if (!m) return;
      feitos++;
      if (feitos % 25 === 0) {
        process.stdout.write(`\r  ${feitos}/${pendentes.length} — ok:${st.ok} falhas:${st.download + st.cripto + st.invalido + st.upload}`);
      }
      if (!m.url || !m.chave) { st.semUrl++; continue; }

      let cifrado;
      try {
        const r = await fetch(m.url, { signal: AbortSignal.timeout(45000) });
        if (!r.ok) { st.download++; continue; }
        cifrado = Buffer.from(await r.arrayBuffer());
      } catch { st.download++; continue; }

      let aberto;
      try {
        aberto = descriptografar(cifrado, m.chave, m.tipo);
      } catch { st.cripto++; continue; }

      if (!pareceValido(aberto, m.mime)) { st.invalido++; continue; }

      const caminho = `${m.tenant_id}/${m.tipo.toLowerCase()}/${m.wa_id}.${extDe(m.mime)}`;
      try {
        await subir(caminho, aberto, m.mime);
      } catch { st.upload++; continue; }

      await prisma.message.update({
        where: { id: m.id },
        data: { media_url: caminho, media_size_bytes: aberto.length },
      });
      st.ok++;
    }
  }

  await Promise.all(Array.from({ length: PARALELO }, trabalhador));
  console.log('');

  console.log('\nRESULTADO');
  console.log('  recuperadas com sucesso....', st.ok);
  console.log('  sem url/chave..............', st.semUrl);
  console.log('  falha no download..........', st.download, '(URL expirada ou fora do ar)');
  console.log('  falha na descriptografia...', st.cripto);
  console.log('  bytes invalidos............', st.invalido, '(descriptografou errado — nao gravado)');
  console.log('  falha no upload............', st.upload);
  console.log('\nAs que falharam continuam com media_url nulo: e so rodar de novo.');
}

main().catch((e) => { console.error('ERRO:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
