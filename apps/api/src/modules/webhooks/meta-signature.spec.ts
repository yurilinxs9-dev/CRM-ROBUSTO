import * as crypto from 'node:crypto';

import {
  extrairPhoneNumberIds,
  nomearEvento,
  resolverDesafio,
  verificarAssinatura,
} from './meta-signature';

const APP_SECRET = 'segredo-do-app-da-meta';

function assinar(corpo: Buffer, secret = APP_SECRET): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(corpo).digest('hex')}`;
}

describe('verificarAssinatura', () => {
  const corpo = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));

  it('aceita assinatura correta', () => {
    expect(verificarAssinatura(corpo, assinar(corpo), APP_SECRET)).toBe(true);
  });

  it('recusa assinatura de outro segredo', () => {
    expect(verificarAssinatura(corpo, assinar(corpo, 'outro'), APP_SECRET)).toBe(false);
  });

  /** O ponto da assinatura: um byte mudado no corpo invalida tudo. */
  it('recusa quando o corpo mudou', () => {
    const header = assinar(corpo);
    const adulterado = Buffer.from(JSON.stringify({ object: 'outra_coisa' }));
    expect(verificarAssinatura(adulterado, header, APP_SECRET)).toBe(false);
  });

  it('recusa header sem o prefixo sha256=', () => {
    const semPrefixo = assinar(corpo).slice('sha256='.length);
    expect(verificarAssinatura(corpo, semPrefixo, APP_SECRET)).toBe(false);
  });

  /**
   * Regressao: hex de tamanho errado fazia timingSafeEqual lancar, e uma
   * excecao aqui viraria 500 — ou seja, um POST malformado derrubava a rota.
   */
  it('recusa hex malformado sem lancar', () => {
    expect(() => verificarAssinatura(corpo, 'sha256=zz', APP_SECRET)).not.toThrow();
    expect(verificarAssinatura(corpo, 'sha256=zz', APP_SECRET)).toBe(false);
  });

  it('recusa corpo ausente, header ausente ou segredo vazio', () => {
    expect(verificarAssinatura(undefined, assinar(corpo), APP_SECRET)).toBe(false);
    expect(verificarAssinatura(corpo, undefined, APP_SECRET)).toBe(false);
    expect(verificarAssinatura(corpo, assinar(corpo), '')).toBe(false);
  });
});

describe('resolverDesafio', () => {
  const TOKEN = 'token-de-verificacao';

  it('devolve o challenge quando modo e token conferem', () => {
    const challenge = resolverDesafio(
      { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' },
      TOKEN,
    );
    expect(challenge).toBe('1158201444');
  });

  it('recusa token errado', () => {
    expect(
      resolverDesafio(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': 'x' },
        TOKEN,
      ),
    ).toBeNull();
  });

  it('recusa modo diferente de subscribe', () => {
    expect(
      resolverDesafio(
        { 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': 'x' },
        TOKEN,
      ),
    ).toBeNull();
  });

  it('recusa query incompleta', () => {
    expect(resolverDesafio({ 'hub.mode': 'subscribe' }, TOKEN)).toBeNull();
  });

  /** Sem token configurado no ambiente, ninguem pode validar o webhook. */
  it('recusa quando o token esperado esta vazio', () => {
    expect(
      resolverDesafio(
        { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'x' },
        '',
      ),
    ).toBeNull();
  });
});

describe('extrairPhoneNumberIds', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
            },
          },
        ],
      },
    ],
  };

  it('extrai o id do numero', () => {
    expect(extrairPhoneNumberIds(payload)).toEqual(['106540352242922']);
  });

  it('deduplica ids repetidos entre changes', () => {
    const duplicado = { entry: [...payload.entry, ...payload.entry] };
    expect(extrairPhoneNumberIds(duplicado)).toEqual(['106540352242922']);
  });

  it('devolve vazio para payload sem entry', () => {
    expect(extrairPhoneNumberIds({})).toEqual([]);
    expect(extrairPhoneNumberIds(null)).toEqual([]);
    expect(extrairPhoneNumberIds({ entry: 'nao-e-array' })).toEqual([]);
  });
});

describe('nomearEvento', () => {
  it('usa o field do change', () => {
    expect(nomearEvento({ entry: [{ changes: [{ field: 'messages' }] }] })).toBe('meta.messages');
  });

  it('cai em meta.unknown sem field reconhecivel', () => {
    expect(nomearEvento({})).toBe('meta.unknown');
    expect(nomearEvento({ entry: [{}] })).toBe('meta.unknown');
  });
});
