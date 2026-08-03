# Follow-up Etapa 1 — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`) para rastreamento.

**Goal:** Fazer o disparo parar quando o cliente responde, respeitar uma janela de horário por empresa, e mostrar no painel quantas conversas cada disparo gerou.

**Architecture:** A decisão de horário vira função pura, sem Prisma nem relógio implícito, testável em isolamento. A detecção de resposta entra como um serviço próprio chamado pelo webhook de entrada, no ramo de mensagem do cliente. `BroadcastTarget` ganha o estado `replied` e um índice por `lead_id` — sem ele o gancho varreria a tabela a cada mensagem recebida.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL (Supabase), BullMQ, Jest 30 + ts-jest, Next.js 14 + Tailwind.

**Spec:** `docs/specs/followup-etapa-1.md`

## Global Constraints

- **Nunca** rodar `prisma migrate deploy` nem `prisma db push` neste banco. O `_prisma_migrations` do Supabase `dzjjpuwqhphgcevjvvbh` tem ~121 linhas e ~47 *unfinished*; `migrate deploy` falha com P3009. Toda DDL vai por script `.cjs` idempotente, no padrão de `apps/api/scripts/migrate-conversation-a.cjs`.
- O hook `rtk` quebra o PATH do `npx prisma`. Chamar sempre via `node ../../node_modules/prisma/build/index.js <comando>`.
- Proibido `any` em código de produção.
- Testes: `cd apps/api && npx jest`. Jest local é **v30**, onde `-v` significa `--version` — usar `--verbose`.
- **Baseline: 12 suites, 124 testes.** Nenhuma tarefa pode reduzir isso.
- `apps/web` precisa continuar compilando (`npx tsc --noEmit`): é o build da Vercel que publica o front, e ele ficou quebrado por semanas até hoje.
- Branch de trabalho: `master` (é o branch de produção deste projeto).
- Scripts de migration leem `DIRECT_URL` de `apps/api/.env`, que aponta para o **session pooler** (`aws-1-sa-east-1.pooler.supabase.com:5432`). O host direto `db.<ref>.supabase.co` é IPv6-only e inalcançável — não tentar.
- Fuso fixo em `America/Sao_Paulo`, o mesmo que o reset do limite diário já assume.

---

### Task 1: Função pura da janela de horário

Isola a única regra nova de decisão numa função sem IO, testável de verdade. As demais tarefas dependem dela estar correta.

**Files:**
- Create: `apps/api/src/modules/broadcasts/broadcast-window.ts`
- Test: `apps/api/src/modules/broadcasts/broadcast-window.spec.ts`

**Interfaces:**
- Consumes: nada
- Produces: `isWithinBroadcastWindow(now: Date, timeZone: string, startHour: number, endHour: number, activeDays: number[]): boolean`

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/api/src/modules/broadcasts/broadcast-window.spec.ts`:

```ts
import { isWithinBroadcastWindow } from './broadcast-window';

const TZ = 'America/Sao_Paulo';
const COMERCIAL = { start: 9, end: 18, days: [1, 2, 3, 4, 5] };

// BRT = UTC-3. 12:00Z = 09:00 em São Paulo.
const at = (utc: string) => new Date(utc);

const dentro = (utc: string) =>
  isWithinBroadcastWindow(at(utc), TZ, COMERCIAL.start, COMERCIAL.end, COMERCIAL.days);

describe('isWithinBroadcastWindow', () => {
  it('segunda 09:00 BRT está dentro (limite inferior é inclusivo)', () => {
    expect(dentro('2026-08-03T12:00:00Z')).toBe(true);
  });

  it('segunda 14:30 BRT está dentro', () => {
    expect(dentro('2026-08-03T17:30:00Z')).toBe(true);
  });

  it('segunda 17:59 BRT ainda está dentro', () => {
    expect(dentro('2026-08-03T20:59:00Z')).toBe(true);
  });

  it('segunda 18:00 BRT está FORA (limite superior é exclusivo)', () => {
    expect(dentro('2026-08-03T21:00:00Z')).toBe(false);
  });

  it('segunda 08:59 BRT está fora', () => {
    expect(dentro('2026-08-03T11:59:00Z')).toBe(false);
  });

  it('madrugada de terça está fora', () => {
    expect(dentro('2026-08-04T06:00:00Z')).toBe(false);
  });

  it('sábado no meio do horário comercial está fora', () => {
    // 2026-08-08 é sábado.
    expect(dentro('2026-08-08T17:00:00Z')).toBe(false);
  });

  it('domingo está fora', () => {
    // 2026-08-09 é domingo.
    expect(dentro('2026-08-09T17:00:00Z')).toBe(false);
  });

  it('janela que inclui sábado aceita sábado', () => {
    expect(
      isWithinBroadcastWindow(at('2026-08-08T17:00:00Z'), TZ, 9, 18, [1, 2, 3, 4, 5, 6]),
    ).toBe(true);
  });

  it('lista de dias vazia nunca dispara', () => {
    expect(isWithinBroadcastWindow(at('2026-08-03T17:00:00Z'), TZ, 9, 18, [])).toBe(false);
  });

  it('meia-noite BRT não é confundida com hora 24', () => {
    // 03:00Z = 00:00 BRT. Uma janela 0-6 tem que aceitar.
    expect(isWithinBroadcastWindow(at('2026-08-04T03:00:00Z'), TZ, 0, 6, [1, 2, 3, 4, 5])).toBe(true);
  });

  it('respeita o fuso: 21:00Z é 18:00 BRT (fora) mas 21:00 em UTC (dentro)', () => {
    const d = at('2026-08-03T21:00:00Z');
    expect(isWithinBroadcastWindow(d, 'America/Sao_Paulo', 9, 18, [1, 2, 3, 4, 5])).toBe(false);
    expect(isWithinBroadcastWindow(d, 'UTC', 9, 22, [1, 2, 3, 4, 5])).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
cd apps/api && npx jest broadcast-window --verbose
```

Esperado: FAIL com `Cannot find module './broadcast-window'`.

- [ ] **Step 3: Implementar**

Criar `apps/api/src/modules/broadcasts/broadcast-window.ts`:

```ts
/**
 * Janela de horário do disparo — função PURA, sem Prisma, sem relógio implícito
 * (mesmo padrão de `leads/lead-visibility.ts` e `webhooks/conversation-routing.ts`).
 *
 * Existe porque o dispatcher é `@Cron(EVERY_MINUTE)` sem nenhuma restrição de
 * horário: um follow-up iniciado às 18h seguia a madrugada inteira, mandando
 * mensagem de vendas às 3 da manhã. Isso é risco de o número ser denunciado.
 */

/** Segunda = 1 ... domingo = 7 (ISO-8601). */
const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

/**
 * `startHour` é inclusivo e `endHour` exclusivo: 9–18 significa que 09:00
 * dispara e 18:00 não. Sem isso, "até as 18h" mandaria mensagem às 18:59.
 *
 * `hourCycle: 'h23'` é obrigatório: com `hour12: false` o Intl devolve "24"
 * para meia-noite em algumas plataformas, e a comparação numérica quebraria
 * silenciosamente numa janela que começa em 0.
 */
export function isWithinBroadcastWindow(
  now: Date,
  timeZone: string,
  startHour: number,
  endHour: number,
  activeDays: number[],
): boolean {
  if (activeDays.length === 0) return false;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now);

  const hourRaw = parts.find((p) => p.type === 'hour')?.value;
  const weekdayRaw = parts.find((p) => p.type === 'weekday')?.value;
  if (hourRaw === undefined || weekdayRaw === undefined) return false;

  const isoDay = WEEKDAY_TO_ISO[weekdayRaw];
  if (isoDay === undefined || !activeDays.includes(isoDay)) return false;

  const hour = Number(hourRaw);
  return hour >= startHour && hour < endHour;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
cd apps/api && npx jest broadcast-window --verbose
```

Esperado: PASS, 12 testes.

- [ ] **Step 5: Rodar a suíte inteira**

```bash
cd apps/api && npx tsc --noEmit && npx jest
```

Esperado: `tsc` limpo, 13 suites e 136 testes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/broadcasts/broadcast-window.ts apps/api/src/modules/broadcasts/broadcast-window.spec.ts
git commit -m "feat(followup): função pura da janela de horário do disparo"
```

---

### Task 2: Schema e DDL

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (enum `BroadcastTargetStatus`, model `BroadcastTarget`, model `Tenant`)
- Create: `apps/api/scripts/migrate-followup-window.cjs`

**Interfaces:**
- Consumes: nada
- Produces: valor de enum `replied`; `BroadcastTarget.replied_at: DateTime?`; índice `(lead_id, status)`; `Tenant.broadcast_window_start: Int`, `Tenant.broadcast_window_end: Int`, `Tenant.broadcast_window_days: Int[]`

- [ ] **Step 1: Alterar o schema**

Em `apps/api/prisma/schema.prisma`, no enum:

```prisma
enum BroadcastTargetStatus {
  pending
  sent
  failed
  skipped // lead com ai_blocked, sem telefone, ou removido
  /// Cliente respondeu DEPOIS de receber a mensagem do disparo. É a métrica
  /// que diz se o follow-up gerou conversa. Distinto de `skipped`: um alvo
  /// que ainda estava na fila quando o cliente escreveu vira `skipped`, não
  /// `replied` — senão a métrica contaria conversas que o disparo não causou.
  replied
}
```

No model `BroadcastTarget`, adicionar o campo e o índice:

```prisma
  replied_at   DateTime?

  @@index([broadcast_id, status])
  /// Pré-requisito, não otimização: o gancho de resposta roda em TODA mensagem
  /// recebida (780 em 3h em produção). Sem este índice, cada mensagem faria
  /// varredura completa de BroadcastTarget.
  @@index([lead_id, status])
```

No model `Tenant`, junto dos outros campos de configuração:

```prisma
  /// Janela em que o follow-up pode disparar, no fuso America/Sao_Paulo.
  /// start inclusivo, end exclusivo. days em ISO-8601: 1=segunda ... 7=domingo.
  broadcast_window_start Int   @default(9)
  broadcast_window_end   Int   @default(18)
  broadcast_window_days  Int[] @default([1, 2, 3, 4, 5])
```

- [ ] **Step 2: Validar e gerar o client**

```bash
cd apps/api && node ../../node_modules/prisma/build/index.js validate && node ../../node_modules/prisma/build/index.js generate
```

Esperado: schema válido e `Generated Prisma Client`.

- [ ] **Step 3: Escrever o script de DDL**

Criar `apps/api/scripts/migrate-followup-window.cjs`:

```js
// Follow-up Etapa 1: valor de enum `replied`, coluna replied_at, índice por
// lead_id, e as três colunas de janela de horário no Tenant.
// Aditivo e idempotente — pode rodar mais de uma vez.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const baseUrl =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=300`;
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

(async () => {
  await x(`SET statement_timeout = '15min'`);

  // 1. Valor novo no enum. ADD VALUE IF NOT EXISTS é idempotente e, no
  //    Postgres 12+, não precisa rodar fora de transação.
  await x(`ALTER TYPE "BroadcastTargetStatus" ADD VALUE IF NOT EXISTS 'replied'`);
  const vals = await q(`
    SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) v
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BroadcastTargetStatus'`);
  console.log('BroadcastTargetStatus:', vals[0].v);

  // 2. Coluna replied_at.
  await x(`ALTER TABLE "BroadcastTarget" ADD COLUMN IF NOT EXISTS "replied_at" timestamp(3)`);

  // 3. Índice por lead_id — pré-requisito do gancho de resposta.
  await x(`CREATE INDEX IF NOT EXISTS "BroadcastTarget_lead_id_status_idx"
    ON "BroadcastTarget"("lead_id", "status")`);

  // 4. Janela de horário no Tenant.
  await x(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "broadcast_window_start" integer NOT NULL DEFAULT 9`);
  await x(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "broadcast_window_end" integer NOT NULL DEFAULT 18`);
  await x(`ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "broadcast_window_days" integer[] NOT NULL DEFAULT '{1,2,3,4,5}'`);

  // 5. Verificação.
  const cols = await q(`SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = 'Tenant' AND column_name LIKE 'broadcast_window%'
    ORDER BY column_name`);
  cols.forEach((c) => console.log(` ${c.column_name} | ${c.data_type} | ${c.column_default}`));
  const idx = await q(`SELECT indexname FROM pg_indexes
    WHERE tablename = 'BroadcastTarget' ORDER BY indexname`);
  console.log('índices:', idx.map((i) => i.indexname).join(', '));
  console.log('OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
```

- [ ] **Step 4: Rodar o script**

```bash
cd apps/api && node scripts/migrate-followup-window.cjs
```

Esperado: termina com `OK`; o enum lista `pending,sent,failed,skipped,replied`; as três colunas de janela aparecem; `BroadcastTarget_lead_id_status_idx` consta nos índices.

- [ ] **Step 5: Rodar de novo para provar idempotência**

```bash
cd apps/api && node scripts/migrate-followup-window.cjs
```

Esperado: mesma saída, sem erro. Se algum statement falhar na segunda execução, o guard está errado — corrigir antes de seguir.

- [ ] **Step 6: Conferir que schema e banco concordam**

```bash
cd apps/api && node ../../node_modules/prisma/build/index.js migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
```

Esperado: o diff **não** deve conter `BroadcastTarget`, `broadcast_window` nem `replied`. Drift pré-existente em `Lead`, `InstanceHidden` e `PushSubscription` é esperado e não é seu.

- [ ] **Step 7: Suíte**

```bash
cd apps/api && npx tsc --noEmit && npx jest
```

Esperado: limpo, 13 suites e 136 testes.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/scripts/migrate-followup-window.cjs
git commit -m "feat(db): estado replied, indice por lead e janela de horario por tenant"
```

---

### Task 3: Detecção da resposta

**Files:**
- Create: `apps/api/src/modules/broadcasts/broadcast-reply.service.ts`
- Create: `apps/api/src/modules/broadcasts/broadcast-reply.service.spec.ts`
- Modify: `apps/api/src/modules/broadcasts/broadcasts.module.ts` (providers + exports)

**Interfaces:**
- Consumes: enum `replied`, `replied_at`, índice `(lead_id, status)` (Task 2)
- Produces: `BroadcastReplyService.registerCustomerReply(leadId: string): Promise<{ replied: number; skipped: number }>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/api/src/modules/broadcasts/broadcast-reply.service.spec.ts`:

```ts
import { BroadcastReplyService } from './broadcast-reply.service';

type Mock = ReturnType<typeof jest.fn>;

function makePrisma(targets: Array<{ id: string; status: string; broadcast_id: string }>) {
  return {
    broadcastTarget: {
      findMany: jest.fn().mockResolvedValue(targets),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe('BroadcastReplyService.registerCustomerReply', () => {
  it('alvo já enviado vira replied', async () => {
    const prisma = makePrisma([{ id: 't1', status: 'sent', broadcast_id: 'b1' }]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');

    expect(r.replied).toBe(1);
    const call = (prisma.broadcastTarget.updateMany as Mock).mock.calls.find(
      ([arg]) => arg.data.status === 'replied',
    );
    expect(call).toBeDefined();
    expect(call[0].where.id.in).toEqual(['t1']);
    expect(call[0].data.replied_at).toBeInstanceOf(Date);
  });

  it('alvo ainda na fila vira skipped, NÃO replied', async () => {
    const prisma = makePrisma([{ id: 't2', status: 'pending', broadcast_id: 'b1' }]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');

    expect(r.skipped).toBe(1);
    expect(r.replied).toBe(0);
    const call = (prisma.broadcastTarget.updateMany as Mock).mock.calls.find(
      ([arg]) => arg.data.status === 'skipped',
    );
    expect(call[0].where.id.in).toEqual(['t2']);
    expect(call[0].data.error).toContain('cliente já estava conversando');
  });

  it('separa os dois grupos na mesma chamada', async () => {
    const prisma = makePrisma([
      { id: 't1', status: 'sent', broadcast_id: 'b1' },
      { id: 't2', status: 'pending', broadcast_id: 'b2' },
    ]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');
    expect(r).toEqual({ replied: 1, skipped: 1 });
  });

  it('lead sem alvo nenhum não escreve nada', async () => {
    const prisma = makePrisma([]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');

    expect(r).toEqual({ replied: 0, skipped: 0 });
    expect(prisma.broadcastTarget.updateMany).not.toHaveBeenCalled();
  });

  it('só considera disparos running ou paused', async () => {
    const prisma = makePrisma([]);
    const svc = new BroadcastReplyService(prisma as never);
    await svc.registerCustomerReply('lead-1');

    const where = (prisma.broadcastTarget.findMany as Mock).mock.calls[0][0].where;
    expect(where.lead_id).toBe('lead-1');
    expect(where.status.in).toEqual(['pending', 'sent']);
    expect(where.broadcast.status.in).toEqual(['running', 'paused']);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
cd apps/api && npx jest broadcast-reply --verbose
```

Esperado: FAIL com `Cannot find module './broadcast-reply.service'`.

- [ ] **Step 3: Implementar o serviço**

Criar `apps/api/src/modules/broadcasts/broadcast-reply.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

const JA_CONVERSANDO = 'cliente já estava conversando';

/**
 * Reage à mensagem do CLIENTE para tirá-lo da fila do follow-up.
 *
 * Antes disto, o disparo só parava por `ai_blocked`, que é ligado quando o TIME
 * envia — nunca quando o cliente responde. Na prática o cliente dizia "já
 * comprei, obrigada" e o robô seguia cutucando a cada 15 minutos. Além do
 * constrangimento, é o comportamento que faz número ser denunciado.
 */
@Injectable()
export class BroadcastReplyService {
  private readonly logger = new Logger(BroadcastReplyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Alvo que JÁ recebeu vira `replied` — é a métrica de conversa gerada.
   * Alvo ainda na fila vira `skipped`: o cliente escreveu por conta própria,
   * então o disparo não causou essa conversa e contá-la infla a métrica.
   *
   * Disparos `done` e `canceled` ficam intocados: histórico não muda.
   */
  async registerCustomerReply(leadId: string): Promise<{ replied: number; skipped: number }> {
    const targets = await this.prisma.broadcastTarget.findMany({
      where: {
        lead_id: leadId,
        status: { in: ['pending', 'sent'] },
        broadcast: { status: { in: ['running', 'paused'] } },
      },
      select: { id: true, status: true, broadcast_id: true },
    });

    if (targets.length === 0) return { replied: 0, skipped: 0 };

    const sentIds = targets.filter((t) => t.status === 'sent').map((t) => t.id);
    const pendingIds = targets.filter((t) => t.status === 'pending').map((t) => t.id);

    if (sentIds.length > 0) {
      await this.prisma.broadcastTarget.updateMany({
        where: { id: { in: sentIds } },
        data: { status: 'replied', replied_at: new Date() },
      });
    }
    if (pendingIds.length > 0) {
      await this.prisma.broadcastTarget.updateMany({
        where: { id: { in: pendingIds } },
        data: { status: 'skipped', error: JA_CONVERSANDO },
      });
    }

    this.logger.log(
      `Resposta do lead ${leadId}: ${sentIds.length} alvo(s) respondido(s), ${pendingIds.length} retirado(s) da fila`,
    );
    return { replied: sentIds.length, skipped: pendingIds.length };
  }
}
```

O model `BroadcastTarget` não declara a relação `broadcast` como navegável no filtro? Declara — `broadcast Broadcast @relation(...)` já existe no schema, então `where: { broadcast: { status: ... } }` funciona.

- [ ] **Step 4: Registrar no módulo**

Em `apps/api/src/modules/broadcasts/broadcasts.module.ts`, importar `BroadcastReplyService` e adicioná-lo em `providers` **e** em `exports` — a Task 4 o consome do módulo de webhooks.

- [ ] **Step 5: Rodar os testes**

```bash
cd apps/api && npx jest broadcast-reply --verbose && npx tsc --noEmit && npx jest
```

Esperado: 5 testes novos passando, `tsc` limpo, 14 suites e 141 testes.

- [ ] **Step 6: Provar que o teste discrimina**

Trocar temporariamente o status de `replied` para `skipped` na primeira `updateMany`, rodar `npx jest broadcast-reply --verbose`, confirmar que o primeiro teste falha, e reverter. Registrar no relatório o que foi observado.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/broadcasts/broadcast-reply.service.ts apps/api/src/modules/broadcasts/broadcast-reply.service.spec.ts apps/api/src/modules/broadcasts/broadcasts.module.ts
git commit -m "feat(followup): resposta do cliente tira o lead da fila do disparo"
```

---

### Task 4: Ligar o gancho no webhook

**Files:**
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts` (construtor; bloco `if (!isFromMe)` do sync de conversa)
- Modify: `apps/api/src/modules/webhooks/webhooks.module.ts` (importar `BroadcastsModule`)
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.spec.ts`

**Interfaces:**
- Consumes: `BroadcastReplyService.registerCustomerReply(leadId)` (Task 3)
- Produces: nenhuma API nova

- [ ] **Step 1: Escrever o teste que falha**

Em `apps/api/src/modules/webhooks/inbound-message.service.spec.ts`, acrescentar ao describe existente, seguindo o padrão de mock já usado no arquivo:

```ts
  it('mensagem do cliente registra a resposta no follow-up', async () => {
    await service.saveIncomingMessage(inputCliente());
    expect(broadcastReply.registerCustomerReply).toHaveBeenCalledWith(lead.id);
  });

  it('mensagem do vendedor NÃO registra resposta', async () => {
    await service.saveIncomingMessage({ ...inputCliente(), isFromMe: true });
    expect(broadcastReply.registerCustomerReply).not.toHaveBeenCalled();
  });
```

Adaptar `inputCliente()` e `lead` aos helpers que o arquivo já define; não criar fixtures paralelas.

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
cd apps/api && npx jest inbound-message --verbose
```

Esperado: FAIL — `broadcastReply` ainda não existe no mock nem no construtor.

- [ ] **Step 3: Injetar e chamar**

No construtor de `InboundMessageService`, adicionar `private readonly broadcastReply: BroadcastReplyService` com o import por caminho relativo (`../broadcasts/broadcast-reply.service`).

Dentro do bloco já guardado por `if (!isFromMe)` — o mesmo que chama `syncLeadFromActive` — acrescentar:

```ts
      // Cliente respondeu: sai da fila de qualquer follow-up ativo. Nunca
      // chamar fora deste guard — mensagem NOSSA não é resposta do cliente,
      // e trataria um envio automático como se o cliente tivesse escrito.
      await this.broadcastReply
        .registerCustomerReply(lead.id)
        .catch((err) => this.logger.warn(`registerCustomerReply falhou lead=${lead.id}: ${String(err)}`));
```

O `catch` é deliberado: falha ao atualizar o follow-up não pode derrubar a ingestão de mensagem, mesmo padrão de `blockAi` e `syncLeadFromActive`.

Em `webhooks.module.ts`, importar `BroadcastsModule` na lista de `imports`.

- [ ] **Step 4: Rodar os testes**

```bash
cd apps/api && npx jest inbound-message --verbose && npx tsc --noEmit && npx jest
```

Esperado: os dois testes novos passando, `tsc` limpo, 14 suites e 143 testes.

> Se surgir dependência circular entre `WebhooksModule` e `BroadcastsModule` (o Nest acusa em tempo de boot), resolver com `forwardRef` nos dois lados, como o Nest documenta — e registrar no relatório que foi necessário.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/webhooks/inbound-message.service.ts apps/api/src/modules/webhooks/inbound-message.service.spec.ts apps/api/src/modules/webhooks/webhooks.module.ts
git commit -m "feat(webhooks): mensagem do cliente interrompe o follow-up"
```

---

### Task 5: Dispatcher respeita a janela

**Files:**
- Modify: `apps/api/src/modules/broadcasts/broadcast.dispatcher.ts:36-81`
- Create: `apps/api/src/modules/broadcasts/broadcast.dispatcher.spec.ts`

**Interfaces:**
- Consumes: `isWithinBroadcastWindow` (Task 1); colunas de janela no `Tenant` (Task 2)
- Produces: nenhuma API nova

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/api/src/modules/broadcasts/broadcast.dispatcher.spec.ts`:

```ts
import { BroadcastDispatcher } from './broadcast.dispatcher';

const TENANT = {
  id: 'tenant-1',
  broadcast_window_start: 9,
  broadcast_window_end: 18,
  broadcast_window_days: [1, 2, 3, 4, 5],
};

const BROADCAST = {
  id: 'b1',
  tenant_id: 'tenant-1',
  status: 'running',
  throttle_seconds: 900,
  daily_limit: 30,
  last_dispatch_at: null,
};

function makeDeps(nowUtc: string) {
  const prisma = {
    broadcast: {
      findMany: jest.fn().mockResolvedValue([BROADCAST]),
      update: jest.fn().mockResolvedValue({}),
    },
    tenant: { findMany: jest.fn().mockResolvedValue([TENANT]) },
    broadcastTarget: {
      findFirst: jest.fn().mockResolvedValue({ id: 't1', created_at: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const sender = { sentToday: jest.fn().mockResolvedValue(0), sendToTarget: jest.fn().mockResolvedValue(undefined) };
  const d = new BroadcastDispatcher(prisma as never, sender as never);
  jest.spyOn(global, 'Date').mockImplementation(() => new Date(nowUtc) as never);
  return { d, prisma, sender };
}

afterEach(() => jest.restoreAllMocks());

describe('BroadcastDispatcher — janela de horário', () => {
  it('dentro da janela, despacha', async () => {
    // 2026-08-03 é segunda. 17:00Z = 14:00 BRT.
    const { d, sender } = makeDeps('2026-08-03T17:00:00Z');
    await d.tick();
    expect(sender.sendToTarget).toHaveBeenCalled();
  });

  it('fora da janela, NÃO despacha', async () => {
    // 03:00Z = 00:00 BRT.
    const { d, sender } = makeDeps('2026-08-04T03:00:00Z');
    await d.tick();
    expect(sender.sendToTarget).not.toHaveBeenCalled();
  });

  it('fora da janela, NÃO marca o alvo como falha', async () => {
    const { d, prisma } = makeDeps('2026-08-04T03:00:00Z');
    await d.tick();
    expect(prisma.broadcastTarget.update).not.toHaveBeenCalled();
  });

  it('fora da janela, NÃO consome a janela de throttle', async () => {
    const { d, prisma } = makeDeps('2026-08-04T03:00:00Z');
    await d.tick();
    const consumiu = (prisma.broadcast.update as jest.Mock).mock.calls.some(
      ([arg]) => arg.data?.last_dispatch_at !== undefined,
    );
    expect(consumiu).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
cd apps/api && npx jest broadcast.dispatcher --verbose
```

Esperado: FAIL nos testes de fora da janela — hoje o dispatcher despacha em qualquer horário.

- [ ] **Step 3: Implementar**

Em `broadcast.dispatcher.ts`, importar `isWithinBroadcastWindow` de `./broadcast-window` e, no início do `tick()`, depois de carregar `running`, resolver os tenants de uma vez:

```ts
    if (running.length === 0) return;

    // Uma consulta por tick, não uma por disparo.
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: [...new Set(running.map((b) => b.tenant_id))] } },
      select: {
        id: true,
        broadcast_window_start: true,
        broadcast_window_end: true,
        broadcast_window_days: true,
      },
    });
    const janelaPorTenant = new Map(tenants.map((t) => [t.id, t]));
```

E, como primeira checagem dentro do `for (const b of running)`, antes do throttle:

```ts
      // Fora da janela a fila apenas ESPERA: nada vira falha, nada é perdido,
      // e o throttle não é consumido — senão o primeiro disparo depois das 9h
      // ficaria esperando mais 15 minutos à toa.
      const janela = janelaPorTenant.get(b.tenant_id);
      if (
        janela &&
        !isWithinBroadcastWindow(
          now,
          'America/Sao_Paulo',
          janela.broadcast_window_start,
          janela.broadcast_window_end,
          janela.broadcast_window_days,
        )
      ) {
        continue;
      }
```

- [ ] **Step 4: Rodar os testes**

```bash
cd apps/api && npx jest broadcast.dispatcher --verbose && npx tsc --noEmit && npx jest
```

Esperado: 4 testes novos passando, `tsc` limpo, 15 suites e 147 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/broadcasts/broadcast.dispatcher.ts apps/api/src/modules/broadcasts/broadcast.dispatcher.spec.ts
git commit -m "feat(followup): disparo respeita a janela de horario do tenant"
```

---

### Task 6: Configuração da janela na tela de ajustes

**Files:**
- Modify: `apps/api/src/modules/tenants/tenants.service.ts` (schema Zod de update + select de leitura)
- Modify: `apps/web/src/app/(dashboard)/settings/components/GeneralTab.tsx`

**Interfaces:**
- Consumes: colunas de janela no `Tenant` (Task 2)
- Produces: nenhuma API nova — usa o endpoint de update de tenant que já existe

- [ ] **Step 1: Expor os campos no backend**

Em `apps/api/src/modules/tenants/tenants.service.ts`, acrescentar ao schema Zod de atualização:

```ts
  broadcast_window_start: z.number().int().min(0).max(23).optional(),
  broadcast_window_end: z.number().int().min(0).max(24).optional(),
  broadcast_window_days: z.array(z.number().int().min(1).max(7)).optional(),
```

`end` aceita 24 porque o limite superior é exclusivo: 0–24 significa o dia inteiro.

Adicionar os três campos ao `select` da leitura do tenant, para que a tela consiga preencher o formulário.

- [ ] **Step 2: Validar que a janela é coerente**

Ainda no service, antes de gravar, rejeitar `start >= end` com `BadRequestException` de mensagem clara — uma janela invertida faria o disparo nunca acontecer, e o usuário não teria como descobrir por quê.

- [ ] **Step 3: Adicionar os controles na tela**

Em `GeneralTab.tsx`, seguindo o padrão dos campos que já existem no arquivo, acrescentar uma seção "Janela de disparo do follow-up" com dois campos de hora e sete botões de alternância para os dias.

Usar classes de token (`bg-surface-*`, `text-ink-*`, `border-line-*`), nunca `style={{}}`. Escrever abaixo dos campos uma frase explicando a regra em português claro, por exemplo: *"Fora desta janela a fila espera — nenhuma mensagem é perdida."*

- [ ] **Step 4: Verificar**

```bash
cd apps/api && npx tsc --noEmit && npx jest && cd ../web && npx tsc --noEmit
```

Esperado: `tsc` limpo dos dois lados, 15 suites e 147 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/tenants apps/web/src/app/\(dashboard\)/settings/components/GeneralTab.tsx
git commit -m "feat(settings): janela de horario do follow-up configuravel por empresa"
```

---

### Task 7: Painel do disparo

**Files:**
- Modify: `apps/web/src/app/(dashboard)/followup/page.tsx:202-259` (o cartão de cada disparo)

**Interfaces:**
- Consumes: contagem `replied` em `target_counts`, que já vem do `groupBy` por status
- Produces: nenhuma API nova

- [ ] **Step 1: Mostrar respostas e falhas com motivo**

No cartão, substituir a linha de contagens por um bloco com três números nomeados — enviados, **respostas** e falhas — sendo respostas o de maior destaque, porque é o que diz se o disparo valeu a pena.

Quando houver falhas, mostrar o motivo mais frequente junto da contagem. O campo `error` já é gravado em `BroadcastTarget` e hoje ninguém vê; buscar via o endpoint `GET /api/broadcasts/:id/targets`, que já existe e já retorna `error`.

- [ ] **Step 2: Mostrar previsão de término**

Calcular a partir dos dados que a lista já traz: pendentes × `throttle_seconds`, limitado por `daily_limit` por dia. Exibir em linguagem natural — "termina hoje por volta das 16h" ou "faltam cerca de 3 dias" — não em segundos.

Quando o disparo estiver fora da janela de horário, dizer isso em vez de contar o tempo: *"pausado até as 9h"*.

- [ ] **Step 3: Substituir os `confirm()` do navegador**

As linhas 239 e 242 usam `confirm()` nativo para cancelar e excluir. Trocar pelo `Dialog` de `@/components/ui/dialog`, que o próprio arquivo já importa e usa em dois outros lugares.

- [ ] **Step 4: Usar tokens em vez de estilo inline**

No cartão reescrito, trocar todo `style={{ color: 'var(--text-muted)' }}` e equivalentes pelas classes `text-ink-3`, `bg-surface-2`, `border-line-2`. O `tailwind.config.ts` define essa escala e traz um comentário dizendo que telas novas devem usá-la sempre. O restante da tela — em especial o formulário de criação — fica como está: é a Etapa 3.

- [ ] **Step 5: Verificar**

```bash
cd apps/web && npx tsc --noEmit
```

Esperado: limpo.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/followup/page.tsx
git commit -m "feat(followup): painel mostra respostas, motivo da falha e previsao"
```

---

## Ordem de deploy

1. Task 2 (DDL) roda **antes** do código novo subir — o gancho e o dispatcher dependem do enum e das colunas.
2. Tasks 1, 3, 4, 5, 6 e 7 sobem juntas.
3. Avisar a equipe antes: disparos que hoje rodam de madrugada passam a parar às 18h e retomar às 9h, e param sozinhos quando o cliente responde.

## Fora de escopo

- Segmentação por temperatura e tags — o campo `segment` continua sem uso (Etapa 2)
- Acabamento visual do resto da tela, incluindo o formulário de criação (Etapa 3)
- Fuso configurável por empresa: fixo em `America/Sao_Paulo`
