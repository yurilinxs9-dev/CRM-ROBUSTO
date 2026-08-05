# Anúncio na conversa — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`) para rastreamento.

**Goal:** Mostrar na conversa do CRM o card do anúncio de onde o lead veio — imagem, título, texto e link — como o WhatsApp do celular já mostra.

**Architecture:** O payload do anúncio já está persistido em `Message.metadata.raw` desde sempre; ninguém o lê. Em vez de mudar o ingest e rodar backfill, a interpretação acontece na leitura: uma função pura traduz o `metadata` para um objeto `AdReferral`, e tanto o histórico do chat quanto o evento WebSocket passam a devolvê-lo. Nenhuma tabela, coluna ou migration é tocada, e os 691 leads históricos ganham o card no primeiro deploy.

**Tech Stack:** NestJS 10, Prisma 5, Socket.IO, Jest 30 + ts-jest, Next.js 14 App Router + Tailwind, lucide-react.

**Spec:** `docs/specs/anuncio-na-conversa.md`

## Global Constraints

- **Nenhuma DDL, nenhuma migration, nenhum `prisma db push`.** Este plano não toca no banco. O `_prisma_migrations` do Supabase `dzjjpuwqhphgcevjvvbh` está poluído (~121 linhas, ~47 *unfinished*) e qualquer escrita de schema exige o procedimento manual do CLAUDE.md.
- Proibido `any` em código de produção (regra 2 do CLAUDE.md). Em arquivos `.spec.ts` o repositório já libera com `/* eslint-disable @typescript-eslint/no-explicit-any */` no topo — seguir esse padrão.
- Testes da API: `cd apps/api && npx jest`. O Jest local é **v30**, onde `-v` significa `--version` — usar `--verbose`.
- **Baseline: 18 suites, 177 testes, todos passando.** Nenhuma tarefa pode reduzir isso.
- `apps/web` precisa continuar compilando (`cd apps/web && npx tsc --noEmit`): é esse build que a Vercel publica.
- O runner de testes do `apps/web` cobre apenas `src/lib/**/*.spec.ts` (ver `apps/web/jest.config.js`); não há runner de componente. A Tarefa 4 é verificada por `tsc --noEmit` e `eslint`, não por teste unitário.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `apps/api/src/modules/webhooks/ad-referral.ts` (novo) | Função pura que traduz `Message.metadata` em `AdReferral \| null`. Sem Prisma, sem Nest. |
| `apps/api/src/modules/webhooks/ad-referral.spec.ts` (novo) | Testes puros do acima, com payloads reais dos dois providers. |
| `apps/api/src/modules/messages/messages.service.ts` (modificar) | `getHistory` passa a devolver `ad_referral` e deixa de vazar `metadata`. |
| `apps/api/src/modules/messages/messages-history-ad.spec.ts` (novo) | Prova que o histórico entrega o card e não entrega o `metadata`. |
| `apps/api/src/modules/webhooks/inbound-message.service.ts` (modificar) | O evento `message:new` passa a carregar `ad_referral`. |
| `apps/web/src/components/chat/types.ts` (modificar) | Tipo `AdReferral` e campo em `ChatMessage`. |
| `apps/web/src/components/chat/ad-referral-card.tsx` (novo) | Desenho do card dentro da bolha. |
| `apps/web/src/components/chat/message-bubble.tsx` (modificar) | Renderiza o card acima do conteúdo. |

---

### Task 1: Extrator de anúncio (função pura)

**Files:**
- Create: `apps/api/src/modules/webhooks/ad-referral.ts`
- Test: `apps/api/src/modules/webhooks/ad-referral.spec.ts`

**Interfaces:**
- Consumes: nada (primeira tarefa).
- Produces: `export interface AdReferral` com os campos `title?: string`, `body?: string`, `source_app?: string`, `source_url?: string`, `source_id?: string`, `media_url?: string`, `ctwa_clid?: string`, `thumbnail_data_url?: string`; e `export function extractAdReferral(metadata: unknown): AdReferral | null`. As Tarefas 2 e 3 importam ambos deste caminho.

**Contexto que o implementador precisa saber:**

O objeto do anúncio vive em dois caminhos diferentes dentro do `metadata` conforme o provider (dado levantado do banco de produção em 2026-08-05):

- Evolution/Baileys: `raw.data.contextInfo.externalAdReply`
- UazAPI: `raw.message.content.contextInfo.externalAdReply`

As mesmas chaves aparecem em duas capitalizações (`sourceUrl` e `sourceURL`, `sourceId` e `sourceID`), e o `thumbnail` chega ora como byte-map (`{"0":255,"1":216,…}`), ora como string base64. O arquivo vizinho `message-extractor.ts:43` já tem um normalizador (`asMediaKey`) escrito exatamente para esse par de formatos — a lógica dele é o modelo a seguir aqui.

- [x] **Step 1: Escrever o teste que falha**

Criar `apps/api/src/modules/webhooks/ad-referral.spec.ts`:

```ts
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
```

- [x] **Step 2: Rodar o teste e confirmar que falha**

```bash
cd apps/api && npx jest ad-referral --verbose
```

Esperado: FAIL com `Cannot find module './ad-referral'`.

- [x] **Step 3: Implementar**

Criar `apps/api/src/modules/webhooks/ad-referral.ts`:

```ts
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
```

- [x] **Step 4: Rodar o teste e confirmar que passa**

```bash
cd apps/api && npx jest ad-referral --verbose
```

Esperado: PASS, 10 testes.

- [x] **Step 5: Rodar a suíte inteira e o lint**

```bash
cd apps/api && npx jest 2>&1 | tail -5 && npx eslint "src/**/*.ts" && npx tsc --noEmit
```

Esperado: **19 suites, 187 testes**, todos passando; lint e typecheck limpos.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/webhooks/ad-referral.ts apps/api/src/modules/webhooks/ad-referral.spec.ts
git commit -m "feat(chat): le o anuncio de origem do payload ja salvo"
```

---

### Task 2: Histórico do chat entrega o card

**Files:**
- Modify: `apps/api/src/modules/messages/messages.service.ts` (método `getHistory`, declarado na linha 920; o `map` que assina URLs está por volta da linha 977)
- Test: `apps/api/src/modules/messages/messages-history-ad.spec.ts` (novo)

**Interfaces:**
- Consumes: `extractAdReferral` e `AdReferral` de `../webhooks/ad-referral` (Tarefa 1).
- Produces: cada item de `getHistory().messages` passa a ter `ad_referral: AdReferral | null` e **deixa de ter** `metadata`. A Tarefa 5 espelha esse contrato no frontend.

**Contexto que o implementador precisa saber:**

`getHistory` é o único consumidor relevante — chamado só por `messages.controller.ts:100` — e o frontend nunca leu `metadata`. Hoje o método devolve a linha inteira do Prisma, então o payload bruto do provider (que chega a dezenas de KB por mensagem) viaja até o navegador sem uso. Tirar `metadata` da resposta é parte do trabalho, não um extra.

Os specs existentes de `MessagesService` (`messages-send-routing.spec.ts`, `messages-outbound-conversation.spec.ts`) mostram o padrão: instanciar o serviço com 12 mocks posicionais e exercitar o método de verdade. Copie a montagem de mocks de `messages-send-routing.spec.ts:23-82`.

- [x] **Step 1: Escrever o teste que falha**

Criar `apps/api/src/modules/messages/messages-history-ad.spec.ts`:

```ts
import { MessagesService } from './messages.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * O card de anúncio é derivado na leitura, não gravado no ingest — ver
 * docs/specs/anuncio-na-conversa.md. Estes testes exercitam `getHistory()` de
 * verdade: um teste que chamasse só `extractAdReferral` passaria igual sem o
 * serviço nunca ter sido ligado ao extrator.
 */

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

const AD_METADATA = {
  raw: {
    data: {
      contextInfo: {
        externalAdReply: {
          title: 'Viva uma formatura inesquecível! ✨',
          body: 'Tudo começa com uma decisão…',
          sourceApp: 'instagram',
          sourceUrl: 'https://www.instagram.com/p/DbDxlGxs6jt/',
          sourceId: '120251874055560237',
        },
      },
    },
  },
};

function makeService(rows: unknown[]) {
  const prisma: any = {
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        responsavel_id: 'u-alex',
        instancia_whatsapp: 'inst-A',
        is_private: false,
      }),
    },
    whatsappInstance: { findMany: jest.fn().mockResolvedValue([]) },
    message: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const media: any = { getSignedUrl: jest.fn().mockResolvedValue('https://signed/x') };
  const service = new MessagesService(
    {} as any, // http
    { get: jest.fn().mockReturnValue('') } as any, // config
    prisma,
    media,
    {} as any, // audio
    { emitNewMessage: jest.fn() } as any, // gateway
    {} as any, // cache
    {} as any, // mediaPipeline
    { add: jest.fn() } as any, // sendQueue
    {} as any, // outboundWebhooks
    {} as any, // push
    {} as any, // conversations
  );
  return { service, prisma };
}

const alex: AuthUser = {
  id: 'u-alex',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

describe('MessagesService.getHistory — card de anúncio', () => {
  it('DISCRIMINANTE: mensagem com anúncio no metadata sai com ad_referral preenchido', async () => {
    const { service } = makeService([
      {
        id: 'm1',
        lead_id: LEAD_ID,
        content: 'Oi, queria saber o preço',
        media_url: null,
        media_archived: false,
        media_thumbnail_path: null,
        metadata: AD_METADATA,
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0].ad_referral).toMatchObject({
      title: 'Viva uma formatura inesquecível! ✨',
      source_app: 'instagram',
      source_id: '120251874055560237',
      source_url: 'https://www.instagram.com/p/DbDxlGxs6jt/',
    });
  });

  it('DISCRIMINANTE: o metadata cru não vaza mais na resposta', async () => {
    const { service } = makeService([
      {
        id: 'm1',
        lead_id: LEAD_ID,
        content: 'Oi',
        media_url: null,
        media_archived: false,
        media_thumbnail_path: null,
        metadata: AD_METADATA,
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0]).not.toHaveProperty('metadata');
    expect(messages[0].id).toBe('m1');
    expect(messages[0].content).toBe('Oi');
  });

  it('mensagem comum sai com ad_referral null', async () => {
    const { service } = makeService([
      {
        id: 'm2',
        lead_id: LEAD_ID,
        content: 'bom dia',
        media_url: null,
        media_archived: false,
        media_thumbnail_path: null,
        metadata: { raw: { data: { conversation: 'bom dia' } } },
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0].ad_referral).toBeNull();
  });

  it('mensagem de mídia continua com a URL assinada, e ganha ad_referral', async () => {
    const { service } = makeService([
      {
        id: 'm3',
        lead_id: LEAD_ID,
        content: null,
        media_url: 'tenant/x.jpg',
        media_archived: false,
        media_thumbnail_path: null,
        metadata: AD_METADATA,
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0].media_url).toBe('https://signed/x');
    expect(messages[0].ad_referral).not.toBeNull();
  });
});
```

- [x] **Step 2: Rodar o teste e confirmar que falha**

```bash
cd apps/api && npx jest messages-history-ad --verbose
```

Esperado: FAIL — `messages[0].ad_referral` é `undefined` e `messages[0]` ainda tem `metadata`.

- [x] **Step 3: Implementar**

No topo de `apps/api/src/modules/messages/messages.service.ts`, junto dos demais imports de módulo:

```ts
import { extractAdReferral } from '../webhooks/ad-referral';
```

Em `getHistory`, substituir o `return` final (hoje logo depois do `const signed = await Promise.all(...)`) por:

```ts
    // O card de anúncio (Click to WhatsApp) é derivado do payload cru que já
    // está em `metadata.raw` — nada é gravado por isso, e conversas antigas
    // ganham o card sem backfill. Ver docs/specs/anuncio-na-conversa.md.
    // O `metadata` em si sai da resposta: nenhum consumidor o lê, e ele levava
    // o payload inteiro do provider até o navegador.
    const withAd = signed.map(({ metadata, ...rest }) => ({
      ...rest,
      ad_referral: extractAdReferral(metadata),
    }));

    return {
      messages: withAd,
      nextCursor: hasMore ? messages[messages.length - 1].id : undefined,
    };
```

- [x] **Step 4: Rodar o teste e confirmar que passa**

```bash
cd apps/api && npx jest messages-history-ad --verbose
```

Esperado: PASS, 4 testes.

- [x] **Step 5: Rodar a suíte inteira, lint e typecheck**

```bash
cd apps/api && npx jest 2>&1 | tail -5 && npx eslint "src/**/*.ts" && npx tsc --noEmit
```

Esperado: **20 suites, 191 testes**, todos passando.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/messages/messages.service.ts apps/api/src/modules/messages/messages-history-ad.spec.ts
git commit -m "feat(chat): historico entrega o card de anuncio e para de vazar metadata"
```

---

### Task 3: Card também na mensagem em tempo real

**Files:**
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts:668`
- Test: `apps/api/src/modules/webhooks/inbound-message.service.spec.ts` (arquivo já existe — acrescentar um caso)

**Interfaces:**
- Consumes: `extractAdReferral` de `./ad-referral` (Tarefa 1).
- Produces: o payload do evento WebSocket `message:new` passa a ter `ad_referral: AdReferral | null` e a não ter `metadata`, igual ao histórico da Tarefa 2.

**Contexto que o implementador precisa saber:**

Sem esta tarefa, o card só apareceria depois de recarregar a conversa: a primeira mensagem de um lead de anúncio chega justamente pelo WebSocket, ao vivo, e é ela que carrega o anúncio.

Atenção: a variável `message` continua sendo usada depois da emissão (em `message.id`, na linha 685, para o webhook de saída). Não destruturar por cima dela — montar um objeto separado só para o emit.

- [x] **Step 1: Escrever o teste que falha**

O arquivo já tem tudo o que é preciso: a fábrica `makeService()` (linha 81), o `leadOwnedByA` (linha 102) e o `baseInput()` (linha 111). Acrescentar no fim do arquivo, **depois** do `});` que fecha o `describe` existente:

```ts
describe('InboundMessageService.saveIncomingMessage — anúncio de origem em tempo real', () => {
  /** Formato Evolution — é este objeto que o serviço grava em metadata.raw. */
  const AD_RAW = {
    data: {
      key: { id: 'wa-ad-1' },
      contextInfo: {
        externalAdReply: {
          title: 'Viva uma formatura inesquecível! ✨',
          sourceApp: 'instagram',
          sourceId: '120251874055560237',
        },
      },
    },
  };

  it('DISCRIMINANTE: message:new carrega ad_referral quando a mensagem veio de anúncio', async () => {
    const { service, prisma, gateway, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-ad',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
      metadata: { raw: AD_RAW },
    });

    await service.saveIncomingMessage(baseInput({ rawPayload: AD_RAW }));

    const [leadId, payload] = gateway.emitNewMessage.mock.calls.at(-1);
    expect(leadId).toBe('lead-1');
    expect(payload.id).toBe('msg-ad');
    expect(payload.ad_referral).toMatchObject({
      title: 'Viva uma formatura inesquecível! ✨',
      source_app: 'instagram',
      source_id: '120251874055560237',
    });
    expect(payload).not.toHaveProperty('metadata');
  });

  it('mensagem comum emite ad_referral null', async () => {
    const { service, prisma, gateway, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
      metadata: { raw: { data: { conversation: 'oi, voltei' } } },
    });

    await service.saveIncomingMessage(baseInput());

    const [, payload] = gateway.emitNewMessage.mock.calls.at(-1);
    expect(payload.ad_referral).toBeNull();
  });
});
```

O `rawPayload` é exatamente o que o serviço grava em `metadata.raw` (ver `inbound-message.service.ts:500`), então o caminho `raw.data.contextInfo.externalAdReply` da Tarefa 1 casa naturalmente. Repare que o mock de `prisma.message.upsert` precisa devolver `metadata` — os testes já existentes no arquivo não devolvem, porque até agora ninguém lia esse campo.

- [x] **Step 2: Rodar o teste e confirmar que falha**

```bash
cd apps/api && npx jest inbound-message --verbose
```

Esperado: FAIL — `payload.ad_referral` é `undefined`.

- [x] **Step 3: Implementar**

No topo de `apps/api/src/modules/webhooks/inbound-message.service.ts`, junto do import vizinho de `./message-extractor`:

```ts
import { extractAdReferral } from './ad-referral';
```

Substituir a linha 668:

```ts
    this.gateway.emitNewMessage(lead.id, message, tenantId);
```

por:

```ts
    // Mesmo contrato do histórico (getHistory): o card do anúncio vai derivado
    // e o metadata cru não viaja. `message` segue intacto — ele ainda é lido
    // logo abaixo pelo webhook de saída.
    const { metadata: rawMetadata, ...messageForEmit } = message;
    this.gateway.emitNewMessage(
      lead.id,
      { ...messageForEmit, ad_referral: extractAdReferral(rawMetadata) },
      tenantId,
    );
```

- [x] **Step 4: Rodar o teste e confirmar que passa**

```bash
cd apps/api && npx jest inbound-message --verbose
```

Esperado: PASS, incluindo os 2 casos novos.

- [x] **Step 5: Rodar a suíte inteira, lint e typecheck**

```bash
cd apps/api && npx jest 2>&1 | tail -5 && npx eslint "src/**/*.ts" && npx tsc --noEmit
```

Esperado: 20 suites, **193 testes**, todos passando.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/webhooks/inbound-message.service.ts apps/api/src/modules/webhooks/inbound-message.service.spec.ts
git commit -m "feat(chat): card de anuncio tambem na mensagem em tempo real"
```

---

### Task 4: Card na conversa

**Files:**
- Modify: `apps/web/src/components/chat/types.ts`
- Create: `apps/web/src/components/chat/ad-referral-card.tsx`
- Modify: `apps/web/src/components/chat/message-bubble.tsx`

**Interfaces:**
- Consumes: o contrato de `ChatMessage.ad_referral` fixado nas Tarefas 2 e 3 — mesmos nomes de campo em `snake_case`.
- Produces: componente `AdReferralCard` com prop `{ ad: AdReferral }`.

**Contexto que o implementador precisa saber:**

Não existe runner de teste de componente neste projeto: `apps/web/jest.config.js` roda apenas `src/lib/**/*.spec.ts`. A verificação desta tarefa é `tsc --noEmit`, `eslint` e conferência visual na conversa.

O card fica **dentro** da bolha, acima do conteúdo. O vocabulário visual vem de `reply-preview.tsx` (barra lateral, `bg-muted/40`, título em `text-[11px] font-semibold`, corpo em `text-xs text-muted-foreground`) e dos blocos de LOCATION/CONTACT em `message-bubble.tsx:305-331` (`rounded-lg bg-background/40 p-2`).

O `next/image` não serve aqui: a origem é um `data:` URI. Usar `<img>` com o mesmo `// eslint-disable-next-line @next/next/no-img-element` que `message-bubble.tsx:263` já usa para o sticker.

- [x] **Step 1: Acrescentar o tipo**

Em `apps/web/src/components/chat/types.ts`, depois de `MessageType`:

```ts
/** Anúncio de onde o lead veio (Click to WhatsApp). Derivado no backend. */
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
```

E dentro de `interface ChatMessage`, junto dos demais campos opcionais:

```ts
  ad_referral?: AdReferral | null;
```

- [x] **Step 2: Criar o componente**

Criar `apps/web/src/components/chat/ad-referral-card.tsx`:

```tsx
'use client';

import { Megaphone } from 'lucide-react';
import { AdReferral } from './types';

/** 'instagram' → 'Instagram'. Sem origem conhecida, só "Anúncio". */
function sourceLabel(app?: string): string {
  if (!app) return 'Anúncio';
  return `Anúncio · ${app.charAt(0).toUpperCase()}${app.slice(1)}`;
}

/** Só o domínio, pra não estourar a largura da bolha com a URL inteira. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

interface AdReferralCardProps {
  ad: AdReferral;
}

/**
 * Card do anúncio de origem, mostrado acima da primeira mensagem do lead —
 * a mesma informação que o WhatsApp do celular exibe e que o CRM não mostrava.
 */
export function AdReferralCard({ ad }: AdReferralCardProps) {
  const link = ad.source_url ?? ad.media_url;

  return (
    <div className="mb-1.5 flex gap-2 rounded-lg border-l-2 border-primary bg-background/40 p-2">
      {ad.thumbnail_data_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ad.thumbnail_data_url}
          alt={ad.title ?? 'Anúncio'}
          className="h-14 w-14 flex-shrink-0 rounded object-cover"
          loading="lazy"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[11px] font-semibold text-primary">
          <Megaphone size={11} className="flex-shrink-0" />
          {sourceLabel(ad.source_app)}
        </p>
        {ad.title && (
          <p className="mt-0.5 line-clamp-2 text-xs font-medium text-foreground">
            {ad.title}
          </p>
        )}
        {ad.body && (
          <p className="mt-0.5 line-clamp-3 text-[11px] text-muted-foreground">
            {ad.body}
          </p>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block truncate text-[11px] text-primary underline underline-offset-2 hover:opacity-80"
          >
            {shortUrl(link)}
          </a>
        )}
      </div>
    </div>
  );
}
```

- [x] **Step 3: Renderizar na bolha**

Em `apps/web/src/components/chat/message-bubble.tsx`, acrescentar o import junto dos demais componentes de chat (linhas 19-23):

```tsx
import { AdReferralCard } from './ad-referral-card';
```

E, dentro de `<div className={bubbleBase}>`, logo **depois** do bloco de ações de hover (que termina no `</div>` da linha 203) e **antes** do primeiro `{type === 'AUDIO' && …}`:

```tsx
        {message.ad_referral && <AdReferralCard ad={message.ad_referral} />}
```

- [x] **Step 4: Verificar tipos e lint**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src
```

Esperado: ambos limpos, sem saída de erro.

O `line-clamp-*` é nativo no Tailwind 3.4 (a versão deste projeto) e já é usado em `components/agenda/task-card.tsx:66` — nenhuma dependência nova é necessária.

- [ ] **Step 5: Conferir na tela** — pendente, depende do usuário

Subir o front (`cd apps/web && npm run dev`), abrir uma conversa de lead vindo de anúncio e confirmar: miniatura carrega, título e texto aparecem, link abre o post em aba nova. Bons candidatos para teste são leads das instâncias `agendamento-vania` e `atendimento-marcelo`, onde a sondagem de produção achou anúncios recentes.

- [x] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/types.ts apps/web/src/components/chat/ad-referral-card.tsx apps/web/src/components/chat/message-bubble.tsx
git commit -m "feat(chat): mostra o card do anuncio de origem na conversa"
```

---

## Verificação final

- [x] `cd apps/api && npx jest` → 20 suites, **192** testes, todos passando (baseline era 18/177; a previsão de 193 estava 1 acima, o total antes da Tarefa 3 era 190, não 191).
- [x] `cd apps/api && npx eslint "src/**/*.ts" && npx tsc --noEmit` → limpos.
- [x] `cd apps/web && npx tsc --noEmit && npx eslint src` → limpos.
- [x] `git log --oneline -4` mostra os quatro commits do plano.
- [x] Nenhum arquivo em `apps/api/prisma/` foi tocado, e nenhum script de banco foi executado.
