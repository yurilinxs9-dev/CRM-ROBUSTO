import { extractAdReferral } from './ad-referral';

/** JPEG mínimo válido: FF D8 FF E0 → base64 "/9j/4A==". */
const JPEG_BYTES = { 0: 255, 1: 216, 2: 255, 3: 224 };
const JPEG_B64 = '/9j/4A==';
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_B64}`;

const AD = {
  title: 'Viva uma formatura inesquecível! ✨',
  body: 'Tudo começa com uma decisão: transformar anos de dedicação…',
  sourceApp: 'instagram',
  sourceUrl: 'https://www.instagram.com/p/DbDxlGxs6jt/',
  sourceId: '120251874055560237',
  mediaUrl: 'https://www.facebook.com/reel/949065808150815/',
  ctwaClid: 'AfgLBjYZquD6-iob2B4-R1TwVFdSYiK8p',
  mediaType: 2,
  thumbnail: JPEG_BYTES,
};

/** Formato Evolution/Baileys. */
const evolutionMeta = (ad: Record<string, unknown>) => ({
  raw: { data: { key: { id: 'x' }, contextInfo: { externalAdReply: ad } } },
});

/** Formato UazAPI. */
const uazapiMeta = (ad: Record<string, unknown>) => ({
  raw: { message: { content: { contextInfo: { externalAdReply: ad } } } },
});

describe('extractAdReferral', () => {
  it('lê o payload da Evolution por inteiro', () => {
    expect(extractAdReferral(evolutionMeta(AD))).toEqual({
      title: 'Viva uma formatura inesquecível! ✨',
      body: 'Tudo começa com uma decisão: transformar anos de dedicação…',
      source_app: 'instagram',
      source_url: 'https://www.instagram.com/p/DbDxlGxs6jt/',
      source_id: '120251874055560237',
      media_url: 'https://www.facebook.com/reel/949065808150815/',
      ctwa_clid: 'AfgLBjYZquD6-iob2B4-R1TwVFdSYiK8p',
      thumbnail_data_url: JPEG_DATA_URL,
    });
  });

  it('lê o payload da UazAPI no outro caminho', () => {
    const r = extractAdReferral(uazapiMeta(AD));
    expect(r?.title).toBe('Viva uma formatura inesquecível! ✨');
    expect(r?.source_id).toBe('120251874055560237');
    expect(r?.thumbnail_data_url).toBe(JPEG_DATA_URL);
  });

  it('DISCRIMINANTE: aceita as chaves na grafia alternativa (sourceURL/sourceID/thumbnailURL)', () => {
    const r = extractAdReferral(
      evolutionMeta({
        title: 'Converse conosco',
        sourceURL: 'https://fb.me/6YjKh7ZqC',
        sourceID: '120248557551840743',
        sourceApp: 'facebook',
      }),
    );
    expect(r?.source_url).toBe('https://fb.me/6YjKh7ZqC');
    expect(r?.source_id).toBe('120248557551840743');
  });

  it('aceita thumbnail já em base64, com o mesmo resultado do byte-map', () => {
    const r = extractAdReferral(evolutionMeta({ ...AD, thumbnail: JPEG_B64 }));
    expect(r?.thumbnail_data_url).toBe(JPEG_DATA_URL);
  });

  it('aceita thumbnail como array de bytes', () => {
    const r = extractAdReferral(evolutionMeta({ ...AD, thumbnail: [255, 216, 255, 224] }));
    expect(r?.thumbnail_data_url).toBe(JPEG_DATA_URL);
  });

  it('DISCRIMINANTE: thumbnail sem magic bytes de JPEG é descartada, o texto sobrevive', () => {
    const r = extractAdReferral(evolutionMeta({ ...AD, thumbnail: [1, 2, 3, 4] }));
    expect(r?.thumbnail_data_url).toBeUndefined();
    expect(r?.title).toBe('Viva uma formatura inesquecível! ✨');
  });

  it('acha o anúncio num caminho desconhecido pela varredura de fallback', () => {
    const meta = { raw: { evento: { payload: { contextInfo: { externalAdReply: AD } } } } };
    expect(extractAdReferral(meta)?.source_id).toBe('120251874055560237');
  });

  it('devolve null quando não há anúncio', () => {
    expect(extractAdReferral({ raw: { data: { conversation: 'oi' } } })).toBeNull();
    expect(extractAdReferral(null)).toBeNull();
    expect(extractAdReferral(undefined)).toBeNull();
    expect(extractAdReferral('lixo')).toBeNull();
    expect(extractAdReferral(42)).toBeNull();
  });

  it('devolve null quando externalAdReply existe mas está vazio', () => {
    expect(extractAdReferral(evolutionMeta({}))).toBeNull();
  });
});

/**
 * `metadata.ad_referral` é o bloco que o ingest grava fora do `raw`. É o único
 * que sobrevive a `pruneMessageRawMetadata` (metadata - 'raw', aos 30 dias).
 */
describe('extractAdReferral — bloco gravado no ingest', () => {
  const STORED = {
    title: 'Sofá sob medida',
    source_app: 'facebook',
    source_url: 'https://fb.me/6YjKh7ZqC',
    thumbnail_data_url: JPEG_DATA_URL,
  };

  it('DISCRIMINANTE: lê o gravado depois do raw ter sido podado', () => {
    // Exatamente o formato de uma mensagem com mais de 30 dias.
    expect(extractAdReferral({ ad_referral: STORED })).toEqual(STORED);
  });

  it('DISCRIMINANTE: o gravado tem precedência sobre o raw', () => {
    const r = extractAdReferral({ ...evolutionMeta(AD), ad_referral: STORED });
    expect(r?.title).toBe('Sofá sob medida');
  });

  it('cai no raw quando o gravado é invalido ou vazio', () => {
    for (const invalido of [{}, null, 'lixo', 42, { title: 7 }]) {
      const r = extractAdReferral({ ...evolutionMeta(AD), ad_referral: invalido });
      expect(r?.title).toBe('Viva uma formatura inesquecível! ✨');
    }
  });

  it('descarta chave estranha que tenha ido parar no bloco gravado', () => {
    const r = extractAdReferral({ ad_referral: { ...STORED, senha: 'nao-vaza' } });
    expect(r).toEqual(STORED);
  });

  it('sem raw e sem gravado, continua null', () => {
    expect(extractAdReferral({ ad_referral: {} })).toBeNull();
  });
});
