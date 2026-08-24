# Cobrança manual no painel admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Painel admin sabe quem pagou (valor + ciclo + pago até), mostra vencidos, e suspende/exclui cliente em poucos cliques; tenant suspenso para de consumir webhook/envio.

**Architecture:** Campos billing direto no model `Tenant` (sem tabela nova). Status derivado por função pura compartilhada. Suspensão vira campo explícito `suspended_at`, checado num único choke point de inbound (resolução de instância) e no processor de envio. Frontend refaz a lista `/admin/tenants` com KPIs, aba Vencidos, ações na linha e modal de exclusão.

**Tech Stack:** NestJS + Prisma (Supabase PG), Zod, Jest/ts-jest, Next.js 14 + TanStack Query + shadcn Dialog.

## Global Constraints

- NUNCA `prisma migrate deploy` nem `db push` (banco poluído — P3009). Migration = `prisma migrate diff` → SQL limpa → aplicar em transação → `prisma migrate resolve --applied` (CLAUDE.md).
- NUNCA `any` no TypeScript. Input HTTP sempre validado com Zod.
- Toda ação admin grava `adminAuditLog`. Toda rota nova usa `PlatformAdminGuard` (já aplicado no controller) + `assertTenantAllowed`.
- `billing_value` em **centavos** (Int). Ciclos válidos: 1, 3, 6, 12.
- Rodar jest do diretório `apps/api`: `npx jest <arquivo> -v`. Typecheck: `npx tsc --noEmit`.
- Commits frequentes, mensagem estilo `feat(api): ...` / `feat(web): ...`.

---

### Task 1: Função pura de billing (status + soma de ciclo)

**Files:**
- Create: `apps/api/src/modules/platform-admin/billing-status.ts`
- Test: `apps/api/src/modules/platform-admin/billing-status.spec.ts`

**Interfaces:**
- Produces:
  - `type BillingStatus = 'sem_cobranca' | 'em_dia' | 'vence_em_breve' | 'vencido'`
  - `deriveBillingStatus(t: { billing_value: number | null; billing_cycle_months: number | null; billing_paid_until: Date | null }, today?: Date): { status: BillingStatus; dias: number }` — `dias`: se `vencido`, dias em atraso (≥1); se `vence_em_breve`/`em_dia`, dias até vencer; se `sem_cobranca`, 0.
  - `addCycleMonths(from: Date, months: number): Date` — soma meses; dia inexistente clampa pro último dia do mês (31/jan + 1 → 28/fev).
  - `monthlyCents(value: number, cycle: number): number` — `Math.round(value / cycle)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { deriveBillingStatus, addCycleMonths, monthlyCents } from './billing-status';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('deriveBillingStatus', () => {
  const base = { billing_value: 30000, billing_cycle_months: 1 };

  it('sem_cobranca quando faltam valor ou paid_until', () => {
    expect(deriveBillingStatus({ billing_value: null, billing_cycle_months: null, billing_paid_until: null }).status).toBe('sem_cobranca');
    expect(deriveBillingStatus({ ...base, billing_cycle_months: 1, billing_paid_until: null }).status).toBe('sem_cobranca');
  });

  it('em_dia quando faltam mais de 3 dias', () => {
    const r = deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-30') }, d('2026-08-24'));
    expect(r).toEqual({ status: 'em_dia', dias: 6 });
  });

  it('vence_em_breve a 3 dias ou menos (limite inclusivo)', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-27') }, d('2026-08-24')).status).toBe('vence_em_breve');
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-24') }, d('2026-08-24'))).toEqual({ status: 'vence_em_breve', dias: 0 });
  });

  it('vencido com dias de atraso', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-20') }, d('2026-08-24'))).toEqual({ status: 'vencido', dias: 4 });
  });
});

describe('addCycleMonths', () => {
  it('soma meses simples', () => {
    expect(addCycleMonths(d('2026-08-10'), 1).toISOString().slice(0, 10)).toBe('2026-09-10');
  });
  it('clampa dia 31 para ultimo dia do mes destino', () => {
    expect(addCycleMonths(d('2026-01-31'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
  it('vira ano no ciclo anual e trimestral', () => {
    expect(addCycleMonths(d('2026-08-24'), 12).toISOString().slice(0, 10)).toBe('2027-08-24');
    expect(addCycleMonths(d('2026-11-30'), 3).toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});

describe('monthlyCents', () => {
  it('normaliza anual e trimestral para mensal', () => {
    expect(monthlyCents(120000, 12)).toBe(10000);
    expect(monthlyCents(100000, 3)).toBe(33333);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest billing-status -v`
Expected: FAIL — `Cannot find module './billing-status'`

- [ ] **Step 3: Write minimal implementation**

```typescript
export type BillingStatus = 'sem_cobranca' | 'em_dia' | 'vence_em_breve' | 'vencido';

const DAY_MS = 86_400_000;
const utcDay = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());

export function deriveBillingStatus(
  t: { billing_value: number | null; billing_cycle_months: number | null; billing_paid_until: Date | null },
  today: Date = new Date(),
): { status: BillingStatus; dias: number } {
  if (t.billing_value == null || t.billing_paid_until == null) return { status: 'sem_cobranca', dias: 0 };
  const diff = Math.round((utcDay(t.billing_paid_until) - utcDay(today)) / DAY_MS);
  if (diff < 0) return { status: 'vencido', dias: -diff };
  if (diff <= 3) return { status: 'vence_em_breve', dias: diff };
  return { status: 'em_dia', dias: diff };
}

export function addCycleMonths(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(from.getUTCDate(), lastDay), 12));
}

export function monthlyCents(value: number, cycle: number): number {
  return Math.round(value / cycle);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest billing-status -v`
Expected: PASS (todos)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/platform-admin/billing-status.ts apps/api/src/modules/platform-admin/billing-status.spec.ts
git commit -m "feat(api): derivacao pura de status de cobranca (ciclos 1/3/6/12, clamp de dia)"
```

---

### Task 2: Migration — campos billing + suspended_at no Tenant

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model Tenant, após `broadcast_window_days`)
- Create: `apps/api/prisma/migrations/manual/2026-08-24-tenant-billing.sql`

**Interfaces:**
- Produces: colunas `Tenant.billing_value Int?`, `Tenant.billing_cycle_months Int?`, `Tenant.billing_paid_until DateTime?`, `Tenant.suspended_at DateTime?` disponíveis no Prisma Client.

- [ ] **Step 1: Editar schema.prisma** — adicionar no model Tenant:

```prisma
  // Cobrança manual (painel admin). Valor em centavos; ciclo 1/3/6/12 meses.
  // billing_paid_until É a data de vencimento (fonte única).
  billing_value        Int?
  billing_cycle_months Int?
  billing_paid_until   DateTime?
  // Suspensão explícita pelo admin (antes era inferida por users inativos).
  suspended_at         DateTime?
```

- [ ] **Step 2: Gerar SQL só-de-objetos-novos** (rtk hook quebra `npx prisma` — usar node direto):

Run (em `apps/api`, com `DIRECT_URL` do `.env` local se existir; senão gerar por diff de schema-a-schema):
`node ../../node_modules/prisma/build/index.js migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/manual/2026-08-24-tenant-billing.sql`
Limpar o arquivo: manter SÓ os `ALTER TABLE "Tenant" ADD COLUMN ...` (drift pré-existente de Lead/InstanceHidden/PushSubscription NÃO entra). Acrescentar no fim o backfill:

```sql
BEGIN;
ALTER TABLE "Tenant" ADD COLUMN "billing_value" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "billing_cycle_months" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "billing_paid_until" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "suspended_at" TIMESTAMP(3);
-- Backfill: tenant já suspenso (todos os users inativos) ganha marca explícita.
UPDATE "Tenant" t SET "suspended_at" = now()
WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.tenant_id = t.id AND u.ativo = true);
COMMIT;
```

(Se o diff gerar exatamente isso, usar o gerado; o bloco acima é o resultado esperado.)

- [ ] **Step 3: `node ../../node_modules/prisma/build/index.js generate`** — client novo compila.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/manual/2026-08-24-tenant-billing.sql
git commit -m "feat(api): campos de cobranca manual + suspended_at no Tenant (SQL manual, banco poluido)"
```

**Nota:** a SQL é aplicada no deploy (Task 8), não agora.

---

### Task 3: Endpoints de billing + listTenants com status

**Files:**
- Modify: `apps/api/src/modules/platform-admin/platform-admin.service.ts`
- Modify: `apps/api/src/modules/platform-admin/platform-admin.controller.ts`
- Test: `apps/api/src/modules/platform-admin/platform-admin.billing.spec.ts`

**Interfaces:**
- Consumes: `deriveBillingStatus`, `addCycleMonths`, `monthlyCents` (Task 1); colunas da Task 2.
- Produces:
  - `PATCH /platform-admin/tenants/:id/billing` body `{ billing_value?: number|null, billing_cycle_months?: 1|3|6|12|null, billing_paid_until?: string|null }`
  - `POST /platform-admin/tenants/:id/billing/mark-paid` → `{ ok: true, paid_until: string }`
  - `GET /platform-admin/billing-summary` → `{ receita_mensal_esperada: number, em_dia: { qtde: number, valor_mensal: number }, vence_em_breve: { qtde: number, valor_mensal: number }, vencidos: { qtde: number, valor_mensal: number }, suspensos: number }` (centavos)
  - `listTenants` row ganha: `billing_value`, `billing_cycle_months`, `billing_paid_until`, `suspended: boolean`, `billing: { status, dias }`

- [ ] **Step 1: Write the failing test** — mock de Prisma no padrão dos specs existentes do módulo (ver `platform-admin.scopes.spec.ts` para o shape do mock):

```typescript
import { PlatformAdminService } from './platform-admin.service';
import type { AuthUser } from '../../common/types/auth-user';

const admin = { id: 'adm', email: 'a@a', tenantId: 't-adm', role: 'SUPER_ADMIN' } as unknown as AuthUser;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

function makeSvc(prismaPatch: Record<string, unknown>) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ platform_scopes: ['*'] }), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), updateMany: jest.fn() },
    tenant: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    whatsappInstance: { groupBy: jest.fn().mockResolvedValue([]) },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    ...prismaPatch,
  };
  const svc = new PlatformAdminService(prisma as never, {} as never, {} as never);
  return { svc, prisma };
}

describe('markTenantPaid', () => {
  it('avanca paid_until pelo ciclo a partir de max(paid_until, hoje) — atrasado nao ganha credito retroativo', async () => {
    const { svc, prisma } = makeSvc({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X', billing_value: 30000, billing_cycle_months: 1, billing_paid_until: d('2026-08-01') }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    await svc.markTenantPaid(admin, 't1', d('2026-08-24'));
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_paid_until.toISOString().slice(0, 10)).toBe('2026-09-24');
    expect(prisma.adminAuditLog.create).toHaveBeenCalled();
  });

  it('adiantado avanca a partir do paid_until futuro', async () => {
    const { svc, prisma } = makeSvc({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X', billing_value: 30000, billing_cycle_months: 3, billing_paid_until: d('2026-09-10') }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    await svc.markTenantPaid(admin, 't1', d('2026-08-24'));
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_paid_until.toISOString().slice(0, 10)).toBe('2026-12-10');
  });

  it('rejeita sem ciclo configurado', async () => {
    const { svc } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X', billing_value: null, billing_cycle_months: null, billing_paid_until: null }), update: jest.fn() },
    });
    await expect(svc.markTenantPaid(admin, 't1')).rejects.toThrow('Cobrança não configurada');
  });
});

describe('billingSummary', () => {
  it('normaliza para mensal e agrupa por status', async () => {
    const { svc } = makeSvc({
      tenant: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          { billing_value: 120000, billing_cycle_months: 12, billing_paid_until: d('2027-01-01'), suspended_at: null },   // em_dia, 10000/mes
          { billing_value: 30000, billing_cycle_months: 1, billing_paid_until: d('2026-08-01'), suspended_at: null },     // vencido
          { billing_value: null, billing_cycle_months: null, billing_paid_until: null, suspended_at: d('2026-08-01') },   // suspenso, sem cobranca
        ]),
        update: jest.fn(),
      },
    });
    const s = await svc.billingSummary(admin, d('2026-08-24'));
    expect(s.receita_mensal_esperada).toBe(40000);
    expect(s.em_dia).toEqual({ qtde: 1, valor_mensal: 10000 });
    expect(s.vencidos).toEqual({ qtde: 1, valor_mensal: 30000 });
    expect(s.suspensos).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest platform-admin.billing -v`
Expected: FAIL — `markTenantPaid is not a function`

- [ ] **Step 3: Implementar no service** (assinaturas exatas; `now` injetável pra teste):

```typescript
// imports novos no topo:
import { deriveBillingStatus, addCycleMonths, monthlyCents } from './billing-status';
import { BadRequestException } from '@nestjs/common'; // juntar ao import existente

const billingSchema = z.object({
  billing_value: z.number().int().min(0).nullable().optional(),
  billing_cycle_months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).nullable().optional(),
  billing_paid_until: z.string().datetime().nullable().optional(),
});

async setTenantBilling(admin: AuthUser, tenantId: string, body: unknown) {
  await this.assertTenantAllowed(admin, tenantId);
  const d = billingSchema.parse(body);
  const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, nome: true } });
  if (!t) throw new NotFoundException('Tenant não encontrado');
  const updated = await this.prisma.tenant.update({
    where: { id: tenantId },
    data: {
      ...(d.billing_value !== undefined ? { billing_value: d.billing_value } : {}),
      ...(d.billing_cycle_months !== undefined ? { billing_cycle_months: d.billing_cycle_months } : {}),
      ...(d.billing_paid_until !== undefined ? { billing_paid_until: d.billing_paid_until ? new Date(d.billing_paid_until) : null } : {}),
    },
    select: { billing_value: true, billing_cycle_months: true, billing_paid_until: true },
  });
  await this.prisma.adminAuditLog.create({
    data: { admin_user_id: admin.id, action: 'tenant_billing_update', target_tenant_id: tenantId, detail: { nome: t.nome, ...d } },
  });
  return { ok: true, ...updated };
}

async markTenantPaid(admin: AuthUser, tenantId: string, now: Date = new Date()) {
  await this.assertTenantAllowed(admin, tenantId);
  const t = await this.prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, nome: true, billing_value: true, billing_cycle_months: true, billing_paid_until: true },
  });
  if (!t) throw new NotFoundException('Tenant não encontrado');
  if (!t.billing_cycle_months) throw new BadRequestException('Cobrança não configurada — defina valor e ciclo antes.');
  const base = t.billing_paid_until && t.billing_paid_until > now ? t.billing_paid_until : now;
  const paidUntil = addCycleMonths(base, t.billing_cycle_months);
  await this.prisma.tenant.update({ where: { id: tenantId }, data: { billing_paid_until: paidUntil } });
  await this.prisma.adminAuditLog.create({
    data: { admin_user_id: admin.id, action: 'tenant_mark_paid', target_tenant_id: tenantId, detail: { nome: t.nome, valor: t.billing_value, paid_until: paidUntil.toISOString() } },
  });
  return { ok: true, paid_until: paidUntil.toISOString() };
}

async billingSummary(admin: AuthUser, now: Date = new Date()) {
  const full = await this.hasFullScope(admin);
  const hidden = new Set(full ? [] : await this.protectedTenantIds());
  const tenants = (await this.prisma.tenant.findMany({
    select: { id: true, billing_value: true, billing_cycle_months: true, billing_paid_until: true, suspended_at: true },
  })).filter((t) => !hidden.has(t.id));
  const acc = {
    receita_mensal_esperada: 0,
    em_dia: { qtde: 0, valor_mensal: 0 },
    vence_em_breve: { qtde: 0, valor_mensal: 0 },
    vencidos: { qtde: 0, valor_mensal: 0 },
    suspensos: 0,
  };
  for (const t of tenants) {
    if (t.suspended_at) acc.suspensos++;
    const { status } = deriveBillingStatus(t, now);
    if (status === 'sem_cobranca') continue;
    const mensal = monthlyCents(t.billing_value as number, t.billing_cycle_months ?? 1);
    acc.receita_mensal_esperada += mensal;
    const bucket = status === 'em_dia' ? acc.em_dia : status === 'vence_em_breve' ? acc.vence_em_breve : acc.vencidos;
    bucket.qtde++;
    bucket.valor_mensal += mensal;
  }
  return acc;
}
```

`listTenants`: acrescentar ao `select` do tenant `billing_value: true, billing_cycle_months: true, billing_paid_until: true, suspended_at: true` e ao map de retorno:

```typescript
      billing_value: t.billing_value,
      billing_cycle_months: t.billing_cycle_months,
      billing_paid_until: t.billing_paid_until,
      suspended: !!t.suspended_at,
      billing: deriveBillingStatus(t),
```

Controller — três rotas novas (padrão das existentes, `PLATFORM_SCOPES` igual a `tenants/:id/suspend`):

```typescript
  @Patch('tenants/:id/billing')
  setBilling(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.svc.setTenantBilling(this.user(req), id, body);
  }

  @Post('tenants/:id/billing/mark-paid')
  markPaid(@Param('id') id: string, @Req() req: Request) {
    return this.svc.markTenantPaid(this.user(req), id);
  }

  @Get('billing-summary')
  billingSummary(@Req() req: Request) {
    return this.svc.billingSummary(this.user(req));
  }
```

(Conferir decorators de scope usados nas rotas vizinhas do controller real e replicar.)

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx jest platform-admin -v` (specs novos e antigos do módulo)
Expected: PASS todos; `npx tsc --noEmit` exit 0

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/platform-admin/
git commit -m "feat(api): endpoints de cobranca manual (configurar, marcar pago, resumo) + status na listagem"
```

---

### Task 4: Suspensão explícita + bloqueio de inbound/envio

**Files:**
- Modify: `apps/api/src/modules/platform-admin/platform-admin.service.ts` (`setTenantSuspended`)
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts` (`findInstanceByName`, `findEvolutionInstanceByName`, `findInstanceByUazapiToken`)
- Modify: `apps/api/src/modules/messages/messages.processor.ts` (guard no início do `process`)
- Test: `apps/api/src/modules/webhooks/suspended-tenant.spec.ts`

**Interfaces:**
- Consumes: `Tenant.suspended_at` (Task 2).
- Produces: instância de tenant suspenso resolve como `null` no inbound (handlers já tratam null como "instância desconhecida" e descartam); job de envio de tenant suspenso é descartado com log.

- [ ] **Step 1: Write the failing test**

```typescript
import { InboundMessageService } from './inbound-message.service';

// Instanciar o service com mocks mínimos — copiar o padrão de construção usado
// em inbound-message.service.spec.ts existente (mesmos stubs de deps), trocando
// só o prisma.whatsappInstance.findFirst.
describe('inbound de tenant suspenso', () => {
  it('findEvolutionInstanceByName retorna null quando tenant.suspended_at setado', async () => {
    const prisma = {
      whatsappInstance: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'i1', tenant_id: 't1', nome: 'x', config: {},
          tenant: { suspended_at: new Date() },
        }),
      },
    };
    const svc = /* construir InboundMessageService com esse prisma (padrão do spec existente) */;
    await expect(svc.findEvolutionInstanceByName('x')).resolves.toBeNull();
  });

  it('resolve normal quando suspended_at null', async () => {
    const prisma = {
      whatsappInstance: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'i1', tenant_id: 't1', nome: 'x', config: {},
          tenant: { suspended_at: null },
        }),
      },
    };
    const svc = /* idem */;
    await expect(svc.findEvolutionInstanceByName('x')).resolves.toMatchObject({ id: 'i1' });
  });
});
```

(O implementador DEVE abrir `inbound-message.service.spec.ts` e copiar o helper de construção real — os stubs exatos das outras deps estão lá.)

- [ ] **Step 2: Run** `cd apps/api && npx jest suspended-tenant -v` — Expected: FAIL (retorna objeto, não null).

- [ ] **Step 3: Implementar**

Nos três finders de `InboundMessageService`: adicionar `tenant: { select: { suspended_at: true } }` ao include/select do `findFirst` e, antes do `return`:

```typescript
    if (instance?.tenant?.suspended_at) {
      this.logger.debug(`inbound descartado: tenant suspenso (instancia ${instance.nome})`);
      return null;
    }
```

Em `messages.processor.ts`, no início de `process(job)`:

```typescript
    const tenantId = (job.data as { tenantId?: string }).tenantId;
    if (tenantId) {
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { suspended_at: true } });
      if (t?.suspended_at) {
        this.logger.warn(`envio descartado: tenant ${tenantId} suspenso (msg ${(job.data as { messageId?: string }).messageId})`);
        return;
      }
    }
```

(Conferir se o processor já injeta `PrismaService`; injetar se não.)

Em `setTenantSuspended` (platform-admin.service.ts), junto do `updateMany` de users:

```typescript
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { suspended_at: suspended ? new Date() : null },
    });
```

- [ ] **Step 4: Run** `cd apps/api && npx jest -v` (suíte toda do api) + `npx tsc --noEmit` — Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/webhooks/ apps/api/src/modules/messages/messages.processor.ts apps/api/src/modules/platform-admin/platform-admin.service.ts
git commit -m "feat(api): tenant suspenso para de processar inbound e envio (suspended_at explicito)"
```

---

### Task 5: Cron de aviso de vencimento

**Files:**
- Create: `apps/api/src/modules/platform-admin/billing-reminder.service.ts`
- Modify: `apps/api/src/modules/platform-admin/platform-admin.module.ts` (registrar provider)
- Test: `apps/api/src/modules/platform-admin/billing-reminder.spec.ts`

**Interfaces:**
- Consumes: `deriveBillingStatus` (Task 1); model `Announcement` (existente: `title`, `body`, `level`, `target_tenant_id`, `active`, `created_by`).
- Produces: `BillingReminderService.run(now?: Date): Promise<{ created: number }>` — chamado por `@Cron('0 12 * * *')` (9h BRT). Título determinístico p/ dedupe: `Fatura vence em breve (DD/MM/AAAA)` ou `Fatura vencida (DD/MM/AAAA)` com a data de `billing_paid_until`.

- [ ] **Step 1: Write the failing test**

```typescript
import { BillingReminderService } from './billing-reminder.service';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

function makeSvc(tenants: unknown[], existing: unknown[] = []) {
  const prisma = {
    tenant: { findMany: jest.fn().mockResolvedValue(tenants) },
    announcement: {
      findFirst: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve((existing as Array<{ title: string; target_tenant_id: string }>).find(
          (a) => a.title === where.title && a.target_tenant_id === where.target_tenant_id,
        ) ?? null)),
      create: jest.fn().mockResolvedValue({}),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'master' }) },
  };
  return { svc: new BillingReminderService(prisma as never), prisma };
}

const tenant = (over: Record<string, unknown>) => ({
  id: 't1', billing_value: 30000, billing_cycle_months: 1, billing_paid_until: d('2026-08-26'), suspended_at: null, ...over,
});

describe('BillingReminderService.run', () => {
  it('cria aviso WARNING para vence_em_breve', async () => {
    const { svc, prisma } = makeSvc([tenant({})]);
    const r = await svc.run(d('2026-08-24'));
    expect(r.created).toBe(1);
    const arg = (prisma.announcement.create as jest.Mock).mock.calls[0][0];
    expect(arg.data.title).toBe('Fatura vence em breve (26/08/2026)');
    expect(arg.data.target_tenant_id).toBe('t1');
  });

  it('cria aviso para vencido e nao duplica se ja existe ativo com mesmo titulo', async () => {
    const { svc } = makeSvc(
      [tenant({ billing_paid_until: d('2026-08-20') })],
      [{ title: 'Fatura vencida (20/08/2026)', target_tenant_id: 't1' }],
    );
    const r = await svc.run(d('2026-08-24'));
    expect(r.created).toBe(0);
  });

  it('ignora sem_cobranca, em_dia e suspensos', async () => {
    const { svc } = makeSvc([
      tenant({ billing_value: null, billing_paid_until: null }),
      tenant({ id: 't2', billing_paid_until: d('2026-12-01') }),
      tenant({ id: 't3', billing_paid_until: d('2026-08-20'), suspended_at: d('2026-08-01') }),
    ]);
    const r = await svc.run(d('2026-08-24'));
    expect(r.created).toBe(0);
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest billing-reminder -v` — Expected: FAIL (module not found).

- [ ] **Step 3: Implementar**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { deriveBillingStatus } from './billing-status';

const fmt = (x: Date) =>
  `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;

@Injectable()
export class BillingReminderService {
  private readonly logger = new Logger(BillingReminderService.name);
  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 12 * * *') // 12:00 UTC = 9h BRT
  async cron(): Promise<void> {
    const r = await this.run().catch((err) => {
      this.logger.warn(`billing reminder falhou: ${String(err)}`);
      return { created: 0 };
    });
    if (r.created) this.logger.log(`billing reminder: ${r.created} aviso(s) criado(s)`);
  }

  async run(now: Date = new Date()): Promise<{ created: number }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { billing_paid_until: { not: null }, suspended_at: null },
      select: { id: true, billing_value: true, billing_cycle_months: true, billing_paid_until: true, suspended_at: true },
    });
    // created_by é NOT NULL no Announcement: usa o primeiro admin master ativo.
    const master = await this.prisma.user.findFirst({
      where: { ativo: true, is_platform_admin: true, platform_scopes: { has: '*' } },
      select: { id: true },
    });
    if (!master) return { created: 0 };
    let created = 0;
    for (const t of tenants) {
      const { status, dias } = deriveBillingStatus(t, now);
      if (status !== 'vence_em_breve' && status !== 'vencido') continue;
      const due = t.billing_paid_until as Date;
      const title = status === 'vencido' ? `Fatura vencida (${fmt(due)})` : `Fatura vence em breve (${fmt(due)})`;
      const dup = await this.prisma.announcement.findFirst({ where: { title, target_tenant_id: t.id, active: true } });
      if (dup) continue;
      await this.prisma.announcement.create({
        data: {
          title,
          body:
            status === 'vencido'
              ? `Sua assinatura venceu há ${dias} dia(s). Regularize o pagamento para evitar suspensão do acesso.`
              : `Sua assinatura vence em ${dias} dia(s) (${fmt(due)}). Evite interrupção do serviço.`,
          level: 'WARNING',
          target_tenant_id: t.id,
          created_by: master.id,
        },
      });
      created++;
    }
    return { created };
  }
}
```

Registrar `BillingReminderService` em `providers` do `platform-admin.module.ts`.
(Conferir campos reais do model `Announcement` no schema antes — ajustar se `created_by` tiver outro nome.)

- [ ] **Step 4: Run** `cd apps/api && npx jest billing-reminder -v` + `npx tsc --noEmit` — Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/platform-admin/
git commit -m "feat(api): aviso automatico de vencimento via announcements (cron diario, dedupe por titulo)"
```

---

### Task 6: Frontend — lista /admin/tenants (KPIs, aba Vencidos, ações na linha, modal excluir)

**Files:**
- Rewrite: `apps/web/src/app/(dashboard)/admin/tenants/page.tsx`
- Create: `apps/web/src/app/(dashboard)/admin/tenants/billing-ui.tsx` (badge, formatadores, modal de exclusão — compartilhado com o detalhe)

**Interfaces:**
- Consumes: `GET /api/platform-admin/tenants` (rows com `billing`, `suspended`, `billing_value`, `billing_paid_until`), `GET /api/platform-admin/billing-summary`, `POST .../billing/mark-paid`, `PATCH .../suspend`, `DELETE .../tenants/:id`, `POST /api/platform-admin/impersonate/:userId`.
- Produces: `BillingBadge({ billing })`, `DeleteTenantDialog({ tenant, onConfirm, open, onOpenChange })`, `moneyFmt(cents)` exportados de `billing-ui.tsx`.

- [ ] **Step 1: `billing-ui.tsx`** — sem teste unitário (projeto web não tem runner); verificação = tsc + build + conferência visual:

```tsx
'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

export interface BillingInfo { status: 'sem_cobranca' | 'em_dia' | 'vence_em_breve' | 'vencido'; dias: number }

export const moneyFmt = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const BADGE: Record<BillingInfo['status'], { bg: string; fg: string; label: (d: number) => string }> = {
  em_dia: { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e', label: () => 'Em dia' },
  vence_em_breve: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: (d) => (d === 0 ? 'Vence hoje' : `Vence em ${d}d`) },
  vencido: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: (d) => `Vencido há ${d}d` },
  sem_cobranca: { bg: 'rgba(107,114,128,0.15)', fg: '#9ca3af', label: () => 'Sem cobrança' },
};

export function BillingBadge({ billing }: { billing: BillingInfo }) {
  const b = BADGE[billing.status];
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: b.bg, color: b.fg }}>
      {b.label(billing.dias)}
    </span>
  );
}

export function DeleteTenantDialog({
  open, onOpenChange, nome, counts, pending, onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  nome: string;
  counts: { users: number; leads: number; instances: number };
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Excluir “{nome}”?</DialogTitle>
          <DialogDescription>
            Exclusão total e irreversível: {counts.users} usuário(s), {counts.leads} lead(s) e {counts.instances} instância(s) serão apagados.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Excluir definitivamente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

(Conferir exports reais de `@/components/ui/dialog`; se `DialogFooter`/`variant="destructive"` não existirem, usar os equivalentes do arquivo.)

- [ ] **Step 2: Reescrever `page.tsx`** mantendo busca e tabs atuais, acrescentando:
  - `TenantRow` ganha `billing: BillingInfo; suspended: boolean; billing_value: number | null; billing_paid_until: string | null; owner` (owner já tem id p/ impersonate).
  - Query extra: `useQuery({ queryKey: ['admin-billing-summary'], queryFn: () => api.get('/api/platform-admin/billing-summary') })`.
  - Cards KPI acima das tabs (grid de 4): Receita mensal esperada (`moneyFmt(s.receita_mensal_esperada)`), Em dia (`qtde` + valor), Vencido (vermelho, `qtde` + valor), Suspensos.
  - Tab nova `overdue` ("Vencidos", count = rows com `billing.status === 'vencido'`), filtro correspondente.
  - Coluna "Pagamento": `<BillingBadge billing={t.billing} />` + `title` tooltip `moneyFmt(t.billing_value)`.
  - Linha suspensa: `opacity-60` + badge `SUSPENSO` ao lado do nome.
  - Ações por linha (ícones com `title`): **Marcar pago** (`POST .../billing/mark-paid`, toast com nova data, invalida `admin-tenants` + `admin-billing-summary`; escondido se `sem_cobranca`), **Suspender/Reativar** (`PATCH .../suspend { suspended: !t.suspended }` com `confirm()` leve), **Entrar como** owner (mutation de impersonate copiada do detalhe, `disabled` sem owner), **Excluir** (abre `DeleteTenantDialog`; estado `deleteTarget` no componente).
  - Remover `askDelete`/`window.prompt`.

- [ ] **Step 3: Verificar**

Run: `cd apps/web && npx tsc --noEmit && npm run build`
Expected: exit 0 nos dois.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/admin/tenants/
git commit -m "feat(web): lista de clientes com KPIs de cobranca, aba Vencidos, acoes na linha e modal de exclusao"
```

---

### Task 7: Frontend — detalhe do tenant (seção Cobrança + modal excluir)

**Files:**
- Modify: `apps/web/src/app/(dashboard)/admin/tenants/[id]/page.tsx`

**Interfaces:**
- Consumes: `BillingBadge`, `DeleteTenantDialog`, `moneyFmt` (Task 6); `PATCH .../billing`; `POST .../billing/mark-paid`. Backend `getTenant` deve retornar os campos billing — **adicionar** `billing_value, billing_cycle_months, billing_paid_until, suspended_at` ao `select` de `getTenant` no `platform-admin.service.ts` (mudança de 1 linha, entra neste commit).

- [ ] **Step 1: Seção Cobrança** (card entre os stats e Equipe):
  - Inputs controlados: valor em reais (converter p/ centavos ao salvar), `Select` ciclo (Mensal 1 / Trimestral 3 / Semestral 6 / Anual 12), date input "pago até" (`<Input type="date">`).
  - Botão "Salvar cobrança" → `PATCH /api/platform-admin/tenants/${id}/billing` com `{ billing_value, billing_cycle_months, billing_paid_until }` (ISO no meio-dia UTC: `new Date(\`${v}T12:00:00Z\`).toISOString()`).
  - Botão "Marcar pago (+ciclo)" → `POST .../billing/mark-paid`, toast `Pago até ${nova data}`.
  - `<BillingBadge billing={deriveClient(data)} />` no header — derivar no cliente com a mesma regra (função local de 6 linhas copiando limites: <0 vencido, ≤3 breve).
  - Badge SUSPENSO passa a ler `!!data.suspended_at` (mantém fallback users-inativos enquanto o campo não é populado em todos: `data.suspended_at != null || (data.users.length > 0 && data.users.every((u) => !u.ativo))`).
  - Trocar o `window.prompt` de exclusão pelo `DeleteTenantDialog`.

- [ ] **Step 2: Verificar** — `cd apps/web && npx tsc --noEmit && npm run build`; `cd apps/api && npx tsc --noEmit` (pela mudança no getTenant). Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/admin/tenants/ apps/api/src/modules/platform-admin/platform-admin.service.ts
git commit -m "feat(web): secao de cobranca no detalhe do cliente + exclusao via modal"
```

---

### Task 8: Deploy + verificação em produção

**Files:** nenhum novo.

- [ ] **Step 1:** `git push origin master` (frontend: Vercel faz deploy sozinho no push).
- [ ] **Step 2: Aplicar migration no VPS** (Windows ssh.exe, alias `crm-vps`):
  - arquivo vive em `apps/api/prisma/manual/2026-08-24-tenant-billing.sql` (FORA de `prisma/migrations/` — lá o Prisma trataria como migration pendente). Copiar pro VPS (`scp` ou heredoc) e aplicar com psql via container OU rodar node+Prisma `$executeRawUnsafe` dentro do `crm-backend` usando `DIRECT_URL`. Transação já está no arquivo; `ADD COLUMN IF NOT EXISTS` torna re-execução segura.
  - registrar: `node ../../node_modules/prisma/build/index.js migrate resolve --applied 2026-08-24-tenant-billing` **não se aplica** (migration manual fora da pasta migrations) — só documentar no arquivo que foi aplicada em produção (comentário com data).
- [ ] **Step 3:** VPS: `cd /opt/crm-whatsapp && git stash push nginx/nginx.conf; git pull origin master && docker compose build crm-backend && docker compose up -d crm-backend`.
- [ ] **Step 4: Verificar:** `curl https://yurilinscrm.duckdns.org/api/health` → ok; abrir `/admin/tenants` no Vercel: KPIs carregam, badge aparece, marcar pago avança data, suspender esconde inbound (mandar msg de teste pra tenant suspenso e conferir que NÃO entra), excluir via modal funciona num tenant descartável.
- [ ] **Step 5:** Atualizar memória do projeto (estado da entrega).

---

## Self-review (feito na escrita)

- Spec coberto: schema (T2), status derivado (T1), endpoints (T3), suspensão + bloqueio inbound/envio (T4), cron aviso (T5), lista (T6), detalhe (T7), guards/audit (T3/T4 usam assertTenantAllowed + auditLog), testes (T1/T3/T4/T5), deploy/migration runbook (T8).
- Sem placeholders TBD; os dois pontos "conferir no arquivo real" (mock helper do inbound spec, exports do dialog) são instruções de leitura obrigatória, com fallback descrito.
- Tipos consistentes: `deriveBillingStatus`/`addCycleMonths`/`monthlyCents` usados em T3/T5 com as assinaturas de T1; `BillingInfo` do front espelha o retorno `{ status, dias }`.
