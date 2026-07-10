import {
  extractFromEvolution,
  extractFromUazapi,
  extractFromWpp,
  synthesizeMessageId,
} from './message-extractor';

describe('extractFromEvolution', () => {
  it('retorna TEXT null quando messageContent é undefined', () => {
    expect(extractFromEvolution(undefined)).toEqual({ type: 'TEXT', content: null });
  });

  it('extrai texto plano de conversation', () => {
    expect(extractFromEvolution({ conversation: 'oi' })).toEqual({ type: 'TEXT', content: 'oi' });
  });

  it('extrai texto de extendedTextMessage', () => {
    const r = extractFromEvolution({ extendedTextMessage: { text: 'link https://x.com' } });
    expect(r).toEqual({ type: 'TEXT', content: 'link https://x.com' });
  });

  it('extrai imagem com caption, dimensões e mediaKey string', () => {
    const r = extractFromEvolution({
      imageMessage: {
        url: 'https://mmg.whatsapp.net/img.enc',
        caption: 'foto',
        mimetype: 'image/jpeg',
        fileLength: '1234',
        width: 800,
        height: 600,
        mediaKey: 'a2V5',
      },
    });
    expect(r.type).toBe('IMAGE');
    expect(r.content).toBe('foto');
    expect(r.media).toMatchObject({
      url: 'https://mmg.whatsapp.net/img.enc',
      mimetype: 'image/jpeg',
      size_bytes: 1234,
      width: 800,
      height: 600,
      mediaKey: 'a2V5',
    });
  });

  it('normaliza mediaKey em formato byte-map (caso iOS/raw-proto que quebrou decrypt)', () => {
    const r = extractFromEvolution({
      imageMessage: { url: 'u', mediaKey: { '0': 1, '1': 2, '2': 3 } },
    });
    expect(r.media?.mediaKey).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('normaliza mediaKey em formato number[]', () => {
    const r = extractFromEvolution({
      audioMessage: { url: 'u', mediaKey: [1, 2, 3] },
    });
    expect(r.media?.mediaKey).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('normaliza mediaKey em formato Buffer JSON { type, data }', () => {
    const r = extractFromEvolution({
      videoMessage: { url: 'u', mediaKey: { type: 'Buffer', data: [255, 0, 128] } },
    });
    expect(r.media?.mediaKey).toBe(Buffer.from([255, 0, 128]).toString('base64'));
  });

  it('descarta mediaKey com bytes inválidos (>255)', () => {
    const r = extractFromEvolution({
      imageMessage: { url: 'u', mediaKey: { '0': 999 } },
    });
    expect(r.media?.mediaKey).toBeUndefined();
  });

  it('usa directPath como fallback de url', () => {
    const r = extractFromEvolution({ imageMessage: { directPath: '/v/t62.7118-24/x' } });
    expect(r.media?.url).toBe('/v/t62.7118-24/x');
  });

  it('extrai áudio PTT com duração', () => {
    const r = extractFromEvolution({
      audioMessage: { url: 'u', mimetype: 'audio/ogg; codecs=opus', seconds: 7 },
    });
    expect(r.type).toBe('AUDIO');
    expect(r.content).toBeNull();
    expect(r.media?.duration_seconds).toBe(7);
  });

  it('extrai documento com fileName', () => {
    const r = extractFromEvolution({
      documentMessage: { url: 'u', fileName: 'orcamento.pdf', mimetype: 'application/pdf' },
    });
    expect(r.type).toBe('DOCUMENT');
    expect(r.media?.filename).toBe('orcamento.pdf');
  });

  it('extrai documentWithCaptionMessage aninhado', () => {
    const r = extractFromEvolution({
      documentWithCaptionMessage: {
        message: {
          documentMessage: { url: 'u', fileName: 'nota.pdf', caption: 'segue nota' },
        },
      },
    });
    expect(r.type).toBe('DOCUMENT');
    expect(r.content).toBe('segue nota');
    expect(r.media?.filename).toBe('nota.pdf');
  });

  it('extrai sticker como STICKER webp', () => {
    const r = extractFromEvolution({ stickerMessage: { url: 'u' } });
    expect(r.type).toBe('STICKER');
    expect(r.media?.mimetype).toBe('image/webp');
  });

  it('extrai localização com lat/lng', () => {
    const r = extractFromEvolution({
      locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: 'Escritório' },
    });
    expect(r.type).toBe('LOCATION');
    expect(r.location).toEqual({ latitude: -23.55, longitude: -46.63, name: 'Escritório' });
  });

  it('extrai contato com vcard', () => {
    const r = extractFromEvolution({
      contactMessage: { displayName: 'João', vcard: 'BEGIN:VCARD...' },
    });
    expect(r.type).toBe('CONTACT');
    expect(r.contact).toEqual({ display_name: 'João', vcard: 'BEGIN:VCARD...' });
  });

  it('converte reaction em TEXT com marcador', () => {
    const r = extractFromEvolution({ reactionMessage: { text: '👍' } });
    expect(r).toEqual({ type: 'TEXT', content: '[reaction] 👍' });
  });

  it('nunca dropa tipo desconhecido — marca como unsupported', () => {
    const r = extractFromEvolution({ pollCreationMessage: { name: 'enquete' } });
    expect(r).toEqual({ type: 'TEXT', content: '[unsupported: pollCreationMessage]' });
  });
});

describe('extractFromUazapi', () => {
  it('extrai texto flat (messageType text)', () => {
    expect(extractFromUazapi({ messageType: 'text', text: 'oi' })).toEqual({
      type: 'TEXT',
      content: 'oi',
    });
  });

  it('extrai ExtendedTextMessage PascalCase com content.text aninhado', () => {
    const r = extractFromUazapi({
      messageType: 'ExtendedTextMessage',
      content: { text: 'mensagem longa' },
    });
    expect(r).toEqual({ type: 'TEXT', content: 'mensagem longa' });
  });

  it('extrai ImageMessage com URL maiúscula aninhada no content', () => {
    const r = extractFromUazapi({
      messageType: 'ImageMessage',
      content: {
        URL: 'https://cdn.uaz/img.jpg',
        caption: 'produto',
        mimetype: 'image/jpeg',
        width: 1080,
        height: 1920,
      },
    });
    expect(r.type).toBe('IMAGE');
    expect(r.content).toBe('produto');
    expect(r.media).toMatchObject({
      url: 'https://cdn.uaz/img.jpg',
      width: 1080,
      height: 1920,
    });
  });

  it('extrai AudioMessage com seconds do content', () => {
    const r = extractFromUazapi({
      messageType: 'AudioMessage',
      content: { URL: 'u', mimetype: 'audio/ogg', seconds: 12 },
    });
    expect(r.type).toBe('AUDIO');
    expect(r.media?.duration_seconds).toBe(12);
  });

  it('extrai DocumentMessage com fileName do content', () => {
    const r = extractFromUazapi({
      messageType: 'DocumentMessage',
      content: { URL: 'u', fileName: 'contrato.pdf', mimetype: 'application/pdf' },
    });
    expect(r.type).toBe('DOCUMENT');
    expect(r.media?.filename).toBe('contrato.pdf');
  });

  it('extrai StickerMessage', () => {
    const r = extractFromUazapi({ messageType: 'StickerMessage', content: { URL: 'u' } });
    expect(r.type).toBe('STICKER');
  });

  it('extrai location com campos flat', () => {
    const r = extractFromUazapi({ messageType: 'location', latitude: -8.05, longitude: -34.9 });
    expect(r.type).toBe('LOCATION');
    expect(r.location?.latitude).toBe(-8.05);
  });

  it('fallback de tipo desconhecido tenta content.text antes de marcar unsupported', () => {
    expect(extractFromUazapi({ messageType: 'WeirdType', content: { text: 'resgatado' } })).toEqual(
      { type: 'TEXT', content: 'resgatado' },
    );
    expect(extractFromUazapi({ messageType: 'WeirdType' })).toEqual({
      type: 'TEXT',
      content: '[unsupported: WeirdType]',
    });
  });
});

describe('extractFromWpp', () => {
  it('extrai chat como TEXT', () => {
    expect(extractFromWpp({ type: 'chat', body: 'oi' })).toEqual({ type: 'TEXT', content: 'oi' });
  });

  it('extrai ptt como AUDIO com duração', () => {
    const r = extractFromWpp({ type: 'ptt', deprecatedMms3Url: 'u', duration: 4 });
    expect(r.type).toBe('AUDIO');
    expect(r.media?.duration_seconds).toBe(4);
  });

  it('extrai location com lat/lng', () => {
    const r = extractFromWpp({ type: 'location', lat: 1.5, lng: 2.5, loc: 'Casa' });
    expect(r.location).toEqual({ latitude: 1.5, longitude: 2.5, name: 'Casa' });
  });

  it('extrai vcard como CONTACT', () => {
    const r = extractFromWpp({ type: 'vcard', body: 'BEGIN:VCARD', displayName: 'Maria' });
    expect(r.type).toBe('CONTACT');
    expect(r.contact?.display_name).toBe('Maria');
  });

  it('tipo desconhecido preserva body ou marca unsupported', () => {
    expect(extractFromWpp({ type: 'weird', body: 'txt' })).toEqual({ type: 'TEXT', content: 'txt' });
    expect(extractFromWpp({ type: 'weird' })).toEqual({
      type: 'TEXT',
      content: '[unsupported: weird]',
    });
  });
});

describe('synthesizeMessageId', () => {
  it('gera id determinístico no formato synth_<prefix>_<ts>_<rand>', () => {
    const id = synthesizeMessageId('tenant1_5581999');
    expect(id).toMatch(/^synth_tenant1_5581999_\d+_[0-9a-f]{8}$/);
  });

  it('gera ids distintos em chamadas consecutivas', () => {
    expect(synthesizeMessageId('x')).not.toBe(synthesizeMessageId('x'));
  });
});
