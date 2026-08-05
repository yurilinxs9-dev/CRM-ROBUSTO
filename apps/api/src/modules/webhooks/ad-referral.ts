/**
 * Card de anúncio (Click to WhatsApp) derivado do payload cru já salvo em
 * `Message.metadata.raw`. Nada é gravado por causa disso: o dado está no banco
 * desde sempre (780 mensagens em 691 leads, levantamento de 2026-08-05) e só
 * nunca foi lido. Ver docs/specs/anuncio-na-conversa.md.
 */

type Obj = Record<string, unknown>;

export interface AdReferral {
  title?: string;
  body?: string;
  source_app?: string;
  source_url?: string;
  source_id?: string;
  media_url?: string;
  ctwa_clid?: string;
  thumbnail_data_url?: string;
}

const AD_KEY = 'externalAdReply';

/** Caminhos conhecidos, um por provider. Testados nesta ordem. */
const KNOWN_PATHS = [
  ['raw', 'data', 'contextInfo', AD_KEY],
  ['raw', 'message', 'content', 'contextInfo', AD_KEY],
];

/** Teto da varredura de fallback — evita percorrer payload gigante à toa. */
const MAX_DEPTH = 8;

const asObj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;

const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/**
 * Primeiro valor de string presente entre as grafias dadas. O WhatsApp manda
 * as mesmas chaves ora camelCase ora com sigla maiúscula (`sourceUrl` e
 * `sourceURL`) — confirmado na amostra de produção.
 */
const pick = (ad: Obj, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = asStr(ad[k]);
    if (v) return v;
  }
  return undefined;
};

/**
 * Normaliza o thumbnail para base64. Ele chega em três formatos:
 *   - string base64      → devolvida como está
 *   - byte-map `{ "0": 255, "1": 216, … }`
 *   - array de números `[255, 216, …]`
 * Mesma variedade que `asMediaKey` trata em message-extractor.ts.
 */
function toBase64(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  let bytes: number[] | undefined;
  if (Array.isArray(value)) {
    bytes = value as number[];
  } else {
    const o = asObj(value);
    if (o) {
      const keys = Object.keys(o);
      if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
        bytes = keys.sort((a, b) => Number(a) - Number(b)).map((k) => o[k] as number);
      }
    }
  }
  if (!bytes || bytes.length === 0) return undefined;
  if (!bytes.every((n) => typeof n === 'number' && n >= 0 && n <= 255)) return undefined;
  return Buffer.from(bytes).toString('base64');
}

/**
 * Só vira data URI o que realmente começa com os magic bytes de JPEG
 * (FF D8 FF). Sem essa checagem, um payload truncado viraria um <img> quebrado
 * na conversa em vez de um card sem imagem.
 */
function toJpegDataUrl(value: unknown): string | undefined {
  const b64 = toBase64(value);
  if (!b64) return undefined;
  let head: Buffer;
  try {
    head = Buffer.from(b64, 'base64').subarray(0, 3);
  } catch {
    return undefined;
  }
  if (head.length < 3 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) {
    return undefined;
  }
  return `data:image/jpeg;base64,${b64}`;
}

/** Varredura em largura limitada, para providers cujo caminho ainda não mapeamos. */
function searchAdNode(root: Obj): Obj | undefined {
  let level: unknown[] = [root];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      const o = asObj(node);
      if (!o) continue;
      const hit = asObj(o[AD_KEY]);
      if (hit) return hit;
      for (const v of Object.values(o)) next.push(v);
    }
    level = next;
  }
  return undefined;
}

function findAdNode(metadata: Obj): Obj | undefined {
  for (const path of KNOWN_PATHS) {
    let node: unknown = metadata;
    for (const key of path) node = asObj(node)?.[key];
    const hit = asObj(node);
    if (hit) return hit;
  }
  return searchAdNode(metadata);
}

/**
 * Devolve o card do anúncio, ou `null` quando a mensagem não veio de anúncio —
 * o caso de 99,3% das mensagens. A checagem por substring evita percorrer o
 * objeto nesse caminho comum.
 */
export function extractAdReferral(metadata: unknown): AdReferral | null {
  const root = asObj(metadata);
  if (!root) return null;

  let serialized: string;
  try {
    serialized = JSON.stringify(root);
  } catch {
    return null;
  }
  if (!serialized.includes(AD_KEY)) return null;

  const ad = findAdNode(root);
  if (!ad) return null;

  const referral: AdReferral = {
    title: pick(ad, 'title'),
    body: pick(ad, 'body'),
    source_app: pick(ad, 'sourceApp', 'sourceType'),
    source_url: pick(ad, 'sourceUrl', 'sourceURL'),
    source_id: pick(ad, 'sourceId', 'sourceID'),
    media_url: pick(ad, 'mediaUrl', 'mediaURL'),
    ctwa_clid: pick(ad, 'ctwaClid'),
    thumbnail_data_url:
      toJpegDataUrl(ad.thumbnail) ?? pick(ad, 'thumbnailUrl', 'thumbnailURL'),
  };

  // Sem nenhum campo aproveitável não há card a mostrar.
  const hasContent = Object.values(referral).some((v) => v !== undefined);
  if (!hasContent) return null;

  for (const key of Object.keys(referral) as (keyof AdReferral)[]) {
    if (referral[key] === undefined) delete referral[key];
  }
  return referral;
}
