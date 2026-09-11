import * as crypto from 'node:crypto';

/**
 * Verificacao do webhook da Meta (WhatsApp Cloud API).
 *
 * Funcoes puras, sem Nest e sem Prisma, porque as duas coisas que importam
 * aqui — comparar HMAC sem vazar tempo e devolver o challenge exato — sao
 * faceis de errar e faceis de testar isoladas.
 *
 * O modelo da Meta e diferente dos outros dois providers:
 *
 *   UazAPI    -> segredo por instancia, viaja NA URL.
 *   Evolution -> nome da instancia no corpo.
 *   Meta      -> UMA url para o App inteiro. Nao ha segredo por instancia; a
 *                autenticidade vem da assinatura HMAC do corpo com o App
 *                Secret, e o tenant sai do phone_number_id do payload.
 */

/** Prefixo do header `X-Hub-Signature-256`. */
const PREFIXO = 'sha256=';

/**
 * Confere `X-Hub-Signature-256` contra o corpo BRUTO.
 *
 * Tem que ser o buffer cru que chegou na conexao: a Meta assina os bytes
 * exatos, e `JSON.stringify(req.body)` nao os reproduz — ordem de chaves,
 * espacos e escape de unicode mudam. Por isso o parser do main.ts guarda o
 * buffer antes do parse, so nesta rota.
 *
 * Devolve false (nunca lanca) para que o chamador decida o status HTTP.
 */
export function verificarAssinatura(
  corpoBruto: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!corpoBruto || !header || !appSecret) return false;
  if (!header.startsWith(PREFIXO)) return false;

  const recebida = header.slice(PREFIXO.length);
  // Hex de SHA-256 tem 64 caracteres. Sem esta checagem, um header malformado
  // chegaria como buffer de outro tamanho e timingSafeEqual lancaria.
  if (!/^[0-9a-f]{64}$/i.test(recebida)) return false;

  const esperada = crypto
    .createHmac('sha256', appSecret)
    .update(corpoBruto)
    .digest('hex');

  const a = Buffer.from(recebida.toLowerCase(), 'hex');
  const b = Buffer.from(esperada, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Query string do handshake de verificacao (GET), como a Meta a envia. */
export interface QueryVerificacao {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

/**
 * Resolve o handshake do GET.
 *
 * A Meta chama a URL uma vez com `hub.mode=subscribe`, o token que voce
 * digitou no painel e um `hub.challenge` aleatorio. Ela so aceita a
 * configuracao se a resposta for o challenge PURO — sem aspas, sem JSON,
 * sem quebra de linha.
 *
 * Devolve o challenge quando confere, ou null quando nao — e null aqui deve
 * virar 403, nao 200, senao qualquer um configura o webhook do App.
 */
export function resolverDesafio(
  query: QueryVerificacao,
  tokenEsperado: string,
): string | null {
  if (!tokenEsperado) return null;
  if (query['hub.mode'] !== 'subscribe') return null;

  const recebido = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (typeof recebido !== 'string' || typeof challenge !== 'string') return null;

  const a = Buffer.from(recebido, 'utf8');
  const b = Buffer.from(tokenEsperado, 'utf8');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return challenge;
}

/**
 * Extrai os `phone_number_id` citados no payload.
 *
 * E por esse id que o tenant e resolvido: o webhook e unico para o App, entao
 * um mesmo POST pode, em tese, trazer entradas de contas diferentes. Ate a via
 * de processamento existir, serve para o log saber de quem era o evento.
 */
export function extrairPhoneNumberIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const raiz = payload as { entry?: unknown } | null;
  if (!raiz || !Array.isArray(raiz.entry)) return [];

  for (const entrada of raiz.entry) {
    const changes = (entrada as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const metadata = (change as { value?: { metadata?: unknown } }).value
        ?.metadata as { phone_number_id?: unknown } | undefined;
      const id = metadata?.phone_number_id;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Nome do evento para a fila e para o WebhookLog.
 *
 * Prefixo `meta.` pelo mesmo motivo do `uazapi.`: o switch do processor e
 * unico para os tres providers e `messages` sozinho colidiria com evento de
 * outro gateway.
 */
export function nomearEvento(payload: unknown): string {
  const raiz = payload as { entry?: unknown } | null;
  if (raiz && Array.isArray(raiz.entry)) {
    for (const entrada of raiz.entry) {
      const changes = (entrada as { changes?: unknown }).changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const field = (change as { field?: unknown }).field;
        if (typeof field === 'string' && field.length > 0) return `meta.${field}`;
      }
    }
  }
  return 'meta.unknown';
}
