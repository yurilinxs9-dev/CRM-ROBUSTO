import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express, { json, urlencoded, type Request } from 'express';

import { verificarAssinatura } from './meta-signature';

/**
 * Fiacao do corpo bruto no pipeline do Express — o pedaco que teste unitario
 * nao alcanca.
 *
 * `meta-signature.spec.ts` prova que o HMAC confere quando recebe os bytes
 * certos. O risco real esta antes disso: se o parser nao guardar o buffer, ou
 * se o `json()` global montado depois atropelar o que o parser especifico
 * fez, a assinatura falha para TODO evento — e a rota simplesmente para de
 * receber, sem erro obvio.
 *
 * O teste sobe um Express com EXATAMENTE a ordem de middlewares do main.ts.
 * Sem banco, sem Redis, sem Nest.
 */

const APP_SECRET = 'segredo-do-app';

/**
 * Corpo com acento e ordem de chaves que o JSON.stringify NAO reproduz igual.
 * E de proposito: e o que torna o reserialize detectavel no ultimo teste.
 */
const CORPO_CRU = Buffer.from(
  '{"object":"whatsapp_business_account","entry":[{"id":"102290129340398","changes":[{"value":{"messages":[{"text":{"body":"Ol\\u00e1, pre\\u00e7o?"}}]},"field":"messages"}]}]}',
  'utf8',
);

function assinar(corpo: Buffer): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(corpo).digest('hex')}`;
}

interface RespostaTeste {
  assinaturaOk: boolean;
  rawBodyPresente: boolean;
  /** Assinatura conferida contra o corpo RE-serializado a partir do parse. */
  assinaturaSobreReserialize: boolean;
  bodyParseado: boolean;
}

/** Reproduz a ordem de middlewares do main.ts, sem o resto da aplicacao. */
function montarApp() {
  const app = express();

  app.use(
    '/api/webhook/meta',
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  // Os genericos vem DEPOIS, como no main.ts. Se estes atropelassem o de cima,
  // rawBody chegaria undefined no handler.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.post('/api/webhook/meta', (req, res) => {
    const { rawBody } = req as Request & { rawBody?: Buffer };
    const header = req.header('x-hub-signature-256');

    const resposta: RespostaTeste = {
      assinaturaOk: verificarAssinatura(rawBody, header, APP_SECRET),
      rawBodyPresente: Boolean(rawBody),
      assinaturaSobreReserialize: verificarAssinatura(
        Buffer.from(JSON.stringify(req.body), 'utf8'),
        header,
        APP_SECRET,
      ),
      bodyParseado: typeof req.body === 'object' && req.body !== null,
    };
    res.json(resposta);
  });

  return app;
}

describe('captura do corpo bruto do webhook da Meta', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = montarApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/api/webhook/meta`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function enviar(corpo: Buffer, assinatura: string): Promise<RespostaTeste> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': assinatura,
      },
      body: new Uint8Array(corpo),
    });
    return (await res.json()) as RespostaTeste;
  }

  it('guarda o buffer cru e a assinatura da Meta confere', async () => {
    const r = await enviar(CORPO_CRU, assinar(CORPO_CRU));
    expect(r.rawBodyPresente).toBe(true);
    expect(r.assinaturaOk).toBe(true);
  });

  it('o json() global montado depois nao apaga o rawBody', async () => {
    const r = await enviar(CORPO_CRU, assinar(CORPO_CRU));
    // As duas coisas ao mesmo tempo: corpo parseado para o handler E buffer
    // preservado para o HMAC.
    expect(r.bodyParseado).toBe(true);
    expect(r.rawBodyPresente).toBe(true);
  });

  /**
   * O teste que justifica a existencia de tudo isso: remontar o corpo a partir
   * do objeto parseado NAO reproduz os bytes originais (aqui, o á escapado
   * volta como caractere literal), entao a assinatura falha. Se algum dia
   * alguem "simplificar" trocando rawBody por JSON.stringify(req.body), este
   * teste quebra.
   */
  it('re-serializar o corpo parseado invalida a assinatura', async () => {
    const r = await enviar(CORPO_CRU, assinar(CORPO_CRU));
    expect(r.assinaturaOk).toBe(true);
    expect(r.assinaturaSobreReserialize).toBe(false);
  });

  it('recusa corpo adulterado em transito', async () => {
    const adulterado = Buffer.from(
      CORPO_CRU.toString('utf8').replace('pre\\u00e7o', 'gr\\u00e1tis'),
      'utf8',
    );
    const r = await enviar(adulterado, assinar(CORPO_CRU));
    expect(r.assinaturaOk).toBe(false);
  });
});
