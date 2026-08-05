# Escopos do admin de plataforma — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir um segundo admin de plataforma que só enxerga Saúde, Avisos e IA e que nunca alcança o tenant do admin master.

**Architecture:** `User.is_platform_admin` continua sendo o portão de entrada do painel; uma coluna nova `User.platform_scopes` (`text[]`) diz o que cada admin pode dentro dele. O `PlatformAdminGuard` lê os escopos do banco e compara com o escopo declarado por rota via decorator `@PlatformScopes(...)`; rota sem decorator exige `*`. Tenant "protegido" é o tenant de qualquer admin com escopo `*`, derivado do dado em vez de UUID fixo.

**Tech Stack:** NestJS 10 + Prisma 5 (Postgres/Supabase), Jest (`ts-jest`) no backend; Next.js 14 App Router + zustand no frontend, com Jest limitado a funções puras em `apps/web/src/lib`.

## Global Constraints

- Nunca usar `any` no TypeScript (regra 2 do `CLAUDE.md`).
- Validar input com Zod (regra 7 do `CLAUDE.md`).
- Migration nunca via `prisma migrate deploy` nem `prisma db push`: o `_prisma_migrations` deste banco está poluído. Aplicar SQL aditiva por script e registrar com `migrate resolve --applied`.
- `npx prisma` está quebrado neste ambiente (hook rtk mexe no PATH). Chamar sempre `node ../../node_modules/prisma/build/index.js ...` a partir de `apps/api`.
- Escopos válidos: `health`, `announcements`, `ai`, e o coringa `*`. Nenhum outro valor.
- Rota sem `@PlatformScopes(...)` exige `*` (fail-closed).
- Comandos de backend rodam com cwd = `apps/api`; comandos de frontend com cwd = `apps/web`.
- Branch de trabalho: `feat/platform-admin-scopes` (já existe, com o spec commitado).

## File Structure

**Backend (`apps/api`)**

| Arquivo | Responsabilidade |
| --- | --- |
| `prisma/schema.prisma` | Declara `User.platform_scopes` |
| `prisma/migrations/20260805120000_add_platform_scopes/migration.sql` | Registro histórico da coluna + backfill |
| `scripts/apply-platform-scopes.mjs` | Aplica a SQL no banco real (one-off) |
| `src/modules/platform-admin/platform-scopes.decorator.ts` | Tipo `PlatformScope`, chave de metadata, decorator |
| `src/modules/platform-admin/platform-admin.guard.ts` | Checagem de admin + escopo |
| `src/modules/platform-admin/platform-admin.guard.spec.ts` | Testes do guard |
| `src/modules/platform-admin/platform-admin.controller.ts` | Declara o escopo de cada rota |
| `src/modules/platform-admin/platform-admin.scopes.spec.ts` | Trava o mapa rota→escopo |
| `src/modules/ai/ai-config.controller.ts` | Declara escopo `ai` no controller |
| `src/modules/platform-admin/platform-admin.service.ts` | `assertTenantAllowed` + uso nos avisos |
| `src/modules/platform-admin/announcement-tenant-guard.spec.ts` | Testes da proteção de tenant |
| `src/modules/auth/auth.service.ts` | `getMe` devolve `platform_scopes` |
| `scripts/set-platform-scopes.cjs` | Concede os escopos ao admin restrito |

**Frontend (`apps/web`)**

| Arquivo | Responsabilidade |
| --- | --- |
| `src/lib/admin-tabs.ts` | Lista de abas + funções puras de filtro/roteamento |
| `src/lib/admin-tabs.spec.ts` | Testes das funções puras |
| `src/stores/auth.store.ts` | Campo `platform_scopes` no `User` |
| `src/app/(dashboard)/layout.tsx` | Propaga `platform_scopes` do `/auth/me` para o store |
| `src/app/(dashboard)/admin/layout.tsx` | Renderiza só as abas permitidas e redireciona |

---

### Task 1: Coluna `platform_scopes` com backfill

O backfill (`['*']` para quem já é platform admin) é obrigatório e roda junto da criação da coluna: o guard da Task 2 trata `[]` como "sem acesso", então uma coluna vazia trancaria o Yuri para fora do painel entre a migration e o script de dados.

**Files:**
- Modify: `apps/api/prisma/schema.prisma:138` (bloco `model User`)
- Create: `apps/api/prisma/migrations/20260805120000_add_platform_scopes/migration.sql`
- Create: `apps/api/scripts/apply-platform-scopes.mjs`

**Interfaces:**
- Consumes: nada.
- Produces: campo Prisma `User.platform_scopes: string[]` (coluna Postgres `"platform_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`), disponível em `select` e em `where: { platform_scopes: { has: '*' } }`.

- [ ] **Step 1: Declarar o campo no schema**

Em `apps/api/prisma/schema.prisma`, dentro de `model User`, logo abaixo da linha `is_platform_admin Boolean          @default(false)`:

```prisma
  /// O que o platform admin pode dentro do painel. ["*"] = master (tudo).
  /// Valores possíveis: "*", "health", "announcements", "ai".
  platform_scopes   String[]         @default([])
```

- [ ] **Step 2: Escrever a migration de registro**

Criar `apps/api/prisma/migrations/20260805120000_add_platform_scopes/migration.sql`:

```sql
-- Escopos do admin de plataforma. Aditivo: só cria coluna nova.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "platform_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: quem já era admin de plataforma vira master, senão perde o painel.
UPDATE "User"
   SET "platform_scopes" = ARRAY['*']
 WHERE "is_platform_admin" = true
   AND cardinality("platform_scopes") = 0;
```

- [ ] **Step 3: Escrever o script que aplica no banco**

Criar `apps/api/scripts/apply-platform-scopes.mjs`:

```js
// One-off: cria User.platform_scopes e promove os admins atuais a master.
// Uso: node scripts/apply-platform-scopes.mjs   (cwd = apps/api)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_URL/DATABASE_URL ausente no .env');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "platform_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`,
    ),
    prisma.$executeRawUnsafe(
      `UPDATE "User" SET "platform_scopes" = ARRAY['*'] WHERE "is_platform_admin" = true AND cardinality("platform_scopes") = 0`,
    ),
  ]);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT email, is_platform_admin, platform_scopes FROM "User" WHERE is_platform_admin = true ORDER BY email`,
  );
  console.log('Admins de plataforma:', rows);
} finally {
  await prisma.$disconnect();
}
```

- [ ] **Step 4: Aplicar no banco**

Run (cwd `apps/api`): `node scripts/apply-platform-scopes.mjs`
Expected: imprime `Admins de plataforma:` com `yurilinsofc@gmail.com` e `platform_scopes: [ '*' ]`.

- [ ] **Step 5: Registrar a migration como aplicada**

Run (cwd `apps/api`): `node ../../node_modules/prisma/build/index.js migrate resolve --applied 20260805120000_add_platform_scopes`
Expected: `Migration 20260805120000_add_platform_scopes marked as applied.`

- [ ] **Step 6: Regenerar o Prisma Client**

Run (cwd `apps/api`): `node ../../node_modules/prisma/build/index.js generate`
Expected: `Generated Prisma Client`.

- [ ] **Step 7: Confirmar que o tipo existe**

Run (cwd `apps/api`): `npm run typecheck`
Expected: sem erros.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260805120000_add_platform_scopes apps/api/scripts/apply-platform-scopes.mjs
git commit -m "feat(db): coluna User.platform_scopes com backfill dos admins atuais"
```

---

### Task 2: Decorator e guard por escopo

**Files:**
- Create: `apps/api/src/modules/platform-admin/platform-scopes.decorator.ts`
- Modify: `apps/api/src/modules/platform-admin/platform-admin.guard.ts`
- Test: `apps/api/src/modules/platform-admin/platform-admin.guard.spec.ts`

**Interfaces:**
- Consumes: `User.platform_scopes` (Task 1).
- Produces:
  - `type PlatformScope = 'health' | 'announcements' | 'ai'`
  - `const PLATFORM_SCOPE_KEY = 'platform_scope'`
  - `const PlatformScopes: (scope: PlatformScope) => MethodDecorator & ClassDecorator`
  - `PlatformAdminGuard` passa a receber `(prisma: PrismaService, reflector: Reflector)` no construtor.

- [ ] **Step 1: Escrever o teste do guard**

Criar `apps/api/src/modules/platform-admin/platform-admin.guard.spec.ts`:

```ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';

type DbUser = { is_platform_admin: boolean; ativo: boolean; platform_scopes: string[] } | null;

function makeGuard(dbUser: DbUser, required?: string) {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(dbUser) } };
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) };
  return new PlatformAdminGuard(prisma as never, reflector as never);
}

function ctx(userId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: userId ? { id: userId } : undefined }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

const MASTER = { is_platform_admin: true, ativo: true, platform_scopes: ['*'] };
const LIMITED = { is_platform_admin: true, ativo: true, platform_scopes: ['health', 'ai'] };

describe('PlatformAdminGuard — escopos', () => {
  it('master passa em rota escopada', async () => {
    await expect(makeGuard(MASTER, 'health').canActivate(ctx('u1'))).resolves.toBe(true);
  });

  it('master passa em rota sem decorator', async () => {
    await expect(makeGuard(MASTER, undefined).canActivate(ctx('u1'))).resolves.toBe(true);
  });

  it('restrito passa no escopo que tem', async () => {
    await expect(makeGuard(LIMITED, 'health').canActivate(ctx('u1'))).resolves.toBe(true);
  });

  it('restrito é barrado no escopo que não tem', async () => {
    // announcements não está na lista dele.
    await expect(makeGuard(LIMITED, 'announcements').canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('restrito é barrado em rota sem decorator', async () => {
    // Fail-closed: rota nova nasce só do master até alguém decidir abrir.
    await expect(makeGuard(LIMITED, undefined).canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('barra usuário inativo mesmo com escopo total', async () => {
    const inativo = { is_platform_admin: true, ativo: false, platform_scopes: ['*'] };
    await expect(makeGuard(inativo, 'health').canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('barra quem não é platform admin', async () => {
    const comum = { is_platform_admin: false, ativo: true, platform_scopes: ['*'] };
    await expect(makeGuard(comum, 'health').canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('barra requisição sem usuário', async () => {
    await expect(makeGuard(MASTER, 'health').canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run (cwd `apps/api`): `npx jest src/modules/platform-admin/platform-admin.guard.spec.ts`
Expected: FAIL — o construtor atual aceita só `prisma`, e nenhum teste de escopo passa.

- [ ] **Step 3: Criar o decorator**

Criar `apps/api/src/modules/platform-admin/platform-scopes.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

/** Áreas do painel de plataforma que podem ser concedidas separadamente. */
export type PlatformScope = 'health' | 'announcements' | 'ai';

export const PLATFORM_SCOPE_KEY = 'platform_scope';

/**
 * Declara o escopo exigido por uma rota (ou por todo um controller). Rota SEM
 * este decorator só é liberada para quem tem o coringa '*' — fail-closed, para
 * que uma rota nova nasça restrita ao admin master.
 */
export const PlatformScopes = (scope: PlatformScope) => SetMetadata(PLATFORM_SCOPE_KEY, scope);
```

- [ ] **Step 4: Reescrever o guard**

Substituir o conteúdo de `apps/api/src/modules/platform-admin/platform-admin.guard.ts`:

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { PLATFORM_SCOPE_KEY, type PlatformScope } from './platform-scopes.decorator';

/**
 * Libera apenas usuários com is_platform_admin=true (verificado no banco, não
 * no JWT — assim revogar o acesso tem efeito imediato) E que tenham o escopo
 * exigido pela rota. Escopo '*' libera tudo; rota sem @PlatformScopes exige '*'.
 * Usar SEMPRE após o JwtAuthGuard (que popula req.user).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('Não autenticado');

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { is_platform_admin: true, ativo: true, platform_scopes: true },
    });
    if (!dbUser?.is_platform_admin || !dbUser.ativo) {
      throw new ForbiddenException('Acesso restrito ao admin de plataforma');
    }

    const scopes = dbUser.platform_scopes ?? [];
    if (scopes.includes('*')) return true;

    const required = this.reflector.getAllAndOverride<PlatformScope | undefined>(PLATFORM_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && scopes.includes(required)) return true;

    throw new ForbiddenException('Acesso restrito ao admin de plataforma');
  }
}
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run (cwd `apps/api`): `npx jest src/modules/platform-admin/platform-admin.guard.spec.ts`
Expected: PASS, 8 testes.

- [ ] **Step 6: Confirmar que nada mais quebrou**

Run (cwd `apps/api`): `npm run typecheck`
Expected: sem erros. (`Reflector` é provido pelo core do Nest, não precisa entrar em `providers`.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/platform-admin/platform-scopes.decorator.ts apps/api/src/modules/platform-admin/platform-admin.guard.ts apps/api/src/modules/platform-admin/platform-admin.guard.spec.ts
git commit -m "feat(api): PlatformAdminGuard checa escopo declarado por rota"
```

---

### Task 3: Declarar o escopo de cada rota

Neste ponto o guard já é fail-closed, então **antes** deste passo todo mundo que não tem `*` está barrado em tudo. É este passo que abre Saúde, Avisos e IA.

**Files:**
- Modify: `apps/api/src/modules/platform-admin/platform-admin.controller.ts`
- Modify: `apps/api/src/modules/ai/ai-config.controller.ts:14-16`
- Test: `apps/api/src/modules/platform-admin/platform-admin.scopes.spec.ts`

**Interfaces:**
- Consumes: `PlatformScopes`, `PLATFORM_SCOPE_KEY` (Task 2).
- Produces: metadata de escopo legível por `Reflector` nos handlers listados abaixo.

- [ ] **Step 1: Escrever o teste que trava o mapa rota→escopo**

Criar `apps/api/src/modules/platform-admin/platform-admin.scopes.spec.ts`:

```ts
import { Reflector } from '@nestjs/core';
import { PlatformAdminController } from './platform-admin.controller';
import { AiConfigController } from '../ai/ai-config.controller';
import { PLATFORM_SCOPE_KEY } from './platform-scopes.decorator';

const reflector = new Reflector();
const scopeOf = (handler: unknown) => reflector.get<string | undefined>(PLATFORM_SCOPE_KEY, handler as never);

describe('mapa rota → escopo', () => {
  const proto = PlatformAdminController.prototype;

  it('saúde exige escopo health', () => {
    expect(scopeOf(proto.health)).toBe('health');
  });

  it('avisos exigem escopo announcements', () => {
    expect(scopeOf(proto.listAnnouncements)).toBe('announcements');
    expect(scopeOf(proto.createAnnouncement)).toBe('announcements');
    expect(scopeOf(proto.setActive)).toBe('announcements');
  });

  it('rotas de risco continuam sem escopo, ou seja, só do master', () => {
    // Sem metadata => o guard exige '*'. Se alguém decorar uma destas por
    // engano, o admin restrito ganha impersonate/exclusão — o teste trava isso.
    for (const h of [
      proto.stats,
      proto.tenants,
      proto.tenant,
      proto.logs,
      proto.banUser,
      proto.deleteUser,
      proto.deleteTenant,
      proto.suspendTenant,
      proto.impersonate,
    ]) {
      expect(scopeOf(h)).toBeUndefined();
    }
  });

  it('painel de IA exige escopo ai no controller inteiro', () => {
    expect(reflector.get<string | undefined>(PLATFORM_SCOPE_KEY, AiConfigController)).toBe('ai');
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run (cwd `apps/api`): `npx jest src/modules/platform-admin/platform-admin.scopes.spec.ts`
Expected: FAIL — `expect(received).toBe('health')` recebendo `undefined`.

- [ ] **Step 3: Decorar as rotas do painel**

Em `apps/api/src/modules/platform-admin/platform-admin.controller.ts`, adicionar ao import de `./platform-scopes.decorator`:

```ts
import { PlatformScopes } from './platform-scopes.decorator';
```

E aplicar o decorator nas quatro rotas liberadas (as demais ficam intocadas):

```ts
  @Get('health')
  @PlatformScopes('health')
  health() {
    return this.svc.health();
  }
```

```ts
  @Get('announcements')
  @PlatformScopes('announcements')
  listAnnouncements() {
    return this.svc.listAnnouncements();
  }

  @Post('announcements')
  @PlatformScopes('announcements')
  createAnnouncement(@Body() body: unknown, @Req() req: Request) {
    return this.svc.createAnnouncement(this.user(req), body);
  }

  @Patch('announcements/:id')
  @PlatformScopes('announcements')
  setActive(@Param('id') id: string, @Body() body: { active: boolean }) {
    return this.svc.setAnnouncementActive(id, !!body?.active);
  }
```

- [ ] **Step 4: Decorar o controller de IA**

Em `apps/api/src/modules/ai/ai-config.controller.ts`, adicionar o import e o decorator de classe:

```ts
import { PlatformScopes } from '../platform-admin/platform-scopes.decorator';
```

```ts
@Controller('ai')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@PlatformScopes('ai')
export class AiConfigController {
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run (cwd `apps/api`): `npx jest src/modules/platform-admin/platform-admin.scopes.spec.ts`
Expected: PASS, 4 testes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/platform-admin/platform-admin.controller.ts apps/api/src/modules/ai/ai-config.controller.ts apps/api/src/modules/platform-admin/platform-admin.scopes.spec.ts
git commit -m "feat(api): declara escopos health/announcements/ai nas rotas do painel"
```

---

### Task 4: Proteger o tenant do admin master

**Files:**
- Modify: `apps/api/src/modules/platform-admin/platform-admin.service.ts:344-368`
- Modify: `apps/api/src/modules/platform-admin/platform-admin.controller.ts` (rota `setActive`)
- Test: `apps/api/src/modules/platform-admin/announcement-tenant-guard.spec.ts`

**Interfaces:**
- Consumes: `User.platform_scopes` (Task 1).
- Produces:
  - `PlatformAdminService.assertTenantAllowed(admin: AuthUser, tenantId: string | null | undefined): Promise<void>` — lança `ForbiddenException` se o caller não tem `*` e o tenant hospeda um admin master.
  - `PlatformAdminService.setAnnouncementActive(admin: AuthUser, id: string, active: boolean)` — assinatura nova, com o caller na frente.

- [ ] **Step 1: Escrever o teste**

Criar `apps/api/src/modules/platform-admin/announcement-tenant-guard.spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { PlatformAdminService } from './platform-admin.service';

// UUIDs de verdade: o announcementSchema valida target_tenant_id com
// z.string().uuid(), então um id fake rejeitaria por Zod e não pelo guard.
const MASTER_TENANT = '282a5498-9592-4efe-b441-1a6b40f8a4ce';
const OUTRO_TENANT = 'abf897e0-8e5c-491e-852e-4669306ec781';

const MASTER = { id: 'admin-master' } as never;
const RESTRITO = { id: 'admin-restrito' } as never;

function makeService() {
  const prisma = {
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ platform_scopes: where.id === 'admin-master' ? ['*'] : ['announcements'] }),
      ),
      count: jest.fn(({ where }: { where: { tenant_id: string } }) =>
        Promise.resolve(where.tenant_id === MASTER_TENANT ? 1 : 0),
      ),
    },
    announcement: {
      create: jest.fn().mockResolvedValue({ id: 'ann-1' }),
      update: jest.fn().mockResolvedValue({ id: 'ann-1' }),
      findUnique: jest.fn().mockResolvedValue({ target_tenant_id: MASTER_TENANT }),
    },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const svc = new PlatformAdminService(prisma as never, {} as never, {} as never);
  return { svc, prisma };
}

const body = (target: string | null) => ({
  title: 'Aviso',
  body: 'Texto do aviso',
  level: 'INFO' as const,
  target_tenant_id: target,
});

describe('avisos — tenant do admin master é intocável', () => {
  it('admin restrito não cria aviso direcionado ao tenant master', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.createAnnouncement(RESTRITO, body(MASTER_TENANT))).rejects.toThrow(ForbiddenException);
    expect(prisma.announcement.create).not.toHaveBeenCalled();
  });

  it('admin restrito cria aviso para outro tenant', async () => {
    const { svc, prisma } = makeService();
    await svc.createAnnouncement(RESTRITO, body(OUTRO_TENANT));
    expect(prisma.announcement.create).toHaveBeenCalled();
  });

  it('admin restrito cria aviso global (sem tenant alvo)', async () => {
    const { svc, prisma } = makeService();
    await svc.createAnnouncement(RESTRITO, body(null));
    expect(prisma.announcement.create).toHaveBeenCalled();
  });

  it('master cria aviso direcionado ao próprio tenant', async () => {
    const { svc, prisma } = makeService();
    await svc.createAnnouncement(MASTER, body(MASTER_TENANT));
    expect(prisma.announcement.create).toHaveBeenCalled();
  });

  it('admin restrito não ativa/desativa aviso do tenant master', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setAnnouncementActive(RESTRITO, 'ann-1', false)).rejects.toThrow(ForbiddenException);
    expect(prisma.announcement.update).not.toHaveBeenCalled();
  });

  it('master ativa/desativa aviso do próprio tenant', async () => {
    const { svc, prisma } = makeService();
    await svc.setAnnouncementActive(MASTER, 'ann-1', false);
    expect(prisma.announcement.update).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run (cwd `apps/api`): `npx jest src/modules/platform-admin/announcement-tenant-guard.spec.ts`
Expected: FAIL — `createAnnouncement` resolve em vez de rejeitar e `setAnnouncementActive` recebe argumentos demais.

- [ ] **Step 3: Implementar `assertTenantAllowed`**

Em `apps/api/src/modules/platform-admin/platform-admin.service.ts`, incluir `ForbiddenException` no import de `@nestjs/common` e adicionar os dois métodos logo acima de `createAnnouncement`:

```ts
  /**
   * Tenant "protegido" é o de qualquer admin de plataforma ativo com escopo
   * total. Derivar do dado (em vez de fixar um UUID) mantém a proteção válida
   * se o admin master mudar de tenant.
   */
  private async isProtectedTenant(tenantId: string): Promise<boolean> {
    const masters = await this.prisma.user.count({
      where: {
        tenant_id: tenantId,
        ativo: true,
        is_platform_admin: true,
        platform_scopes: { has: '*' },
      },
    });
    return masters > 0;
  }

  /** Barra admin sem escopo total de agir sobre o tenant do admin master. */
  async assertTenantAllowed(admin: AuthUser, tenantId: string | null | undefined): Promise<void> {
    if (!tenantId) return;
    const caller = await this.prisma.user.findUnique({
      where: { id: admin.id },
      select: { platform_scopes: true },
    });
    if (caller?.platform_scopes?.includes('*')) return;
    if (await this.isProtectedTenant(tenantId)) {
      throw new ForbiddenException('Tenant protegido');
    }
  }
```

- [ ] **Step 4: Usar a checagem nos dois pontos de escrita**

Em `createAnnouncement`, logo após o `parse`:

```ts
  async createAnnouncement(admin: AuthUser, body: unknown) {
    const d = announcementSchema.parse(body);
    await this.assertTenantAllowed(admin, d.target_tenant_id);
    const created = await this.prisma.announcement.create({
```

E substituir `setAnnouncementActive` inteiro:

```ts
  async setAnnouncementActive(admin: AuthUser, id: string, active: boolean) {
    const ann = await this.prisma.announcement.findUnique({
      where: { id },
      select: { target_tenant_id: true },
    });
    await this.assertTenantAllowed(admin, ann?.target_tenant_id);
    return this.prisma.announcement.update({ where: { id }, data: { active } });
  }
```

- [ ] **Step 5: Ajustar o controller à nova assinatura**

Em `apps/api/src/modules/platform-admin/platform-admin.controller.ts`:

```ts
  @Patch('announcements/:id')
  @PlatformScopes('announcements')
  setActive(@Param('id') id: string, @Body() body: { active: boolean }, @Req() req: Request) {
    return this.svc.setAnnouncementActive(this.user(req), id, !!body?.active);
  }
```

- [ ] **Step 6: Rodar o teste e ver passar**

Run (cwd `apps/api`): `npx jest src/modules/platform-admin/announcement-tenant-guard.spec.ts`
Expected: PASS, 6 testes.

- [ ] **Step 7: Rodar a suíte inteira do backend**

Run (cwd `apps/api`): `npm test`
Expected: PASS. Se algum teste antigo chamava `setAnnouncementActive(id, active)`, corrigir para a assinatura nova.

- [ ] **Step 8: Typecheck**

Run (cwd `apps/api`): `npm run typecheck`
Expected: sem erros.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/platform-admin/platform-admin.service.ts apps/api/src/modules/platform-admin/platform-admin.controller.ts apps/api/src/modules/platform-admin/announcement-tenant-guard.spec.ts
git commit -m "feat(api): bloqueia admin restrito de agir sobre o tenant do master"
```

---

### Task 5: `/auth/me` devolve os escopos

**Files:**
- Modify: `apps/api/src/modules/auth/auth.service.ts:286-291`

**Interfaces:**
- Consumes: `User.platform_scopes` (Task 1).
- Produces: `GET /api/auth/me` responde `{ user: { ..., is_platform_admin: boolean, platform_scopes: string[] }, tenant: {...} }`.

- [ ] **Step 1: Incluir o campo no select**

Em `apps/api/src/modules/auth/auth.service.ts`, dentro de `getMe`, trocar o `select` do usuário por:

```ts
        select: { id: true, nome: true, email: true, role: true, ativo: true, avatar_url: true, titulo: true, especialidade: true, is_platform_admin: true, platform_scopes: true },
```

- [ ] **Step 2: Typecheck**

Run (cwd `apps/api`): `npm run typecheck`
Expected: sem erros.

- [ ] **Step 3: Conferir a resposta real**

Run (cwd `apps/api`), com a API rodando localmente ou contra produção usando um token válido do Yuri:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/auth/me
```

Expected: o objeto `user` traz `"platform_scopes":["*"]`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/auth/auth.service.ts
git commit -m "feat(api): /auth/me devolve platform_scopes"
```

---

### Task 6: Funções puras das abas do admin

O runner de teste do frontend (`apps/web/jest.config.js`) só enxerga `src/lib/**/*.spec.ts` e não renderiza componente. Por isso toda a decisão de "quais abas mostrar" e "para onde redirecionar" mora aqui, e o layout vira só apresentação.

**Files:**
- Create: `apps/web/src/lib/admin-tabs.ts`
- Test: `apps/web/src/lib/admin-tabs.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type PlatformScope = 'health' | 'announcements' | 'ai' | '*'`
  - `interface AdminTab { href: string; label: string; scope: PlatformScope }`
  - `const ADMIN_TABS: AdminTab[]`
  - `visibleAdminTabs(scopes: string[] | undefined): AdminTab[]`
  - `adminTabForPath(pathname: string): AdminTab | undefined`
  - `canSeeAdminPath(pathname: string, scopes: string[] | undefined): boolean`
  - `firstAllowedAdminHref(scopes: string[] | undefined): string | undefined`

- [ ] **Step 1: Escrever o teste**

Criar `apps/web/src/lib/admin-tabs.spec.ts`:

```ts
import {
  ADMIN_TABS,
  visibleAdminTabs,
  adminTabForPath,
  canSeeAdminPath,
  firstAllowedAdminHref,
} from './admin-tabs';

const MASTER = ['*'];
const RESTRITO = ['health', 'announcements', 'ai'];

describe('visibleAdminTabs', () => {
  it('master vê todas as abas', () => {
    expect(visibleAdminTabs(MASTER)).toHaveLength(ADMIN_TABS.length);
  });

  it('restrito vê só Saúde, Avisos e IA, nessa ordem', () => {
    expect(visibleAdminTabs(RESTRITO).map((t) => t.href)).toEqual([
      '/admin/health',
      '/admin/announcements',
      '/admin/ai',
    ]);
  });

  it('sem escopo não vê aba nenhuma', () => {
    expect(visibleAdminTabs([])).toEqual([]);
    expect(visibleAdminTabs(undefined)).toEqual([]);
  });
});

describe('adminTabForPath', () => {
  it('casa /admin exato com Visão geral', () => {
    expect(adminTabForPath('/admin')?.href).toBe('/admin');
  });

  it('casa subrota com a aba mais específica', () => {
    expect(adminTabForPath('/admin/tenants/abc-123')?.href).toBe('/admin/tenants');
    expect(adminTabForPath('/admin/health')?.href).toBe('/admin/health');
  });

  it('devolve undefined para caminho fora do painel', () => {
    expect(adminTabForPath('/dashboard')).toBeUndefined();
  });
});

describe('canSeeAdminPath', () => {
  it('restrito não entra na Visão geral nem em Clientes ou Logs', () => {
    expect(canSeeAdminPath('/admin', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/tenants', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/tenants/abc-123', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/logs', RESTRITO)).toBe(false);
  });

  it('restrito entra nas três abas dele', () => {
    expect(canSeeAdminPath('/admin/health', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/announcements', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/ai', RESTRITO)).toBe(true);
  });

  it('master entra em tudo', () => {
    expect(canSeeAdminPath('/admin', MASTER)).toBe(true);
    expect(canSeeAdminPath('/admin/logs', MASTER)).toBe(true);
  });

  it('caminho desconhecido dentro do painel é negado para o restrito', () => {
    // Aba nova sem escopo declarado não pode vazar por omissão.
    expect(canSeeAdminPath('/admin/qualquer-coisa-nova', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/qualquer-coisa-nova', MASTER)).toBe(true);
  });
});

describe('firstAllowedAdminHref', () => {
  it('restrito cai em Saúde', () => {
    expect(firstAllowedAdminHref(RESTRITO)).toBe('/admin/health');
  });

  it('master cai na Visão geral', () => {
    expect(firstAllowedAdminHref(MASTER)).toBe('/admin');
  });

  it('sem escopo não há destino', () => {
    expect(firstAllowedAdminHref([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run (cwd `apps/web`): `npx jest src/lib/admin-tabs.spec.ts`
Expected: FAIL — `Cannot find module './admin-tabs'`.

- [ ] **Step 3: Implementar**

Criar `apps/web/src/lib/admin-tabs.ts`:

```ts
/**
 * Abas do painel de plataforma e as regras de visibilidade por escopo.
 * Lógica pura, fora do componente, porque o runner de teste do web só cobre
 * `src/lib` — e é aqui que mora a decisão de quem vê o quê.
 */
export type PlatformScope = 'health' | 'announcements' | 'ai' | '*';

export interface AdminTab {
  href: string;
  label: string;
  scope: PlatformScope;
}

export const ADMIN_TABS: AdminTab[] = [
  { href: '/admin', label: 'Visão geral', scope: '*' },
  { href: '/admin/tenants', label: 'Clientes', scope: '*' },
  { href: '/admin/health', label: 'Saúde', scope: 'health' },
  { href: '/admin/logs', label: 'Logs', scope: '*' },
  { href: '/admin/announcements', label: 'Avisos', scope: 'announcements' },
  { href: '/admin/ai', label: 'IA', scope: 'ai' },
];

const hasScope = (scopes: string[] | undefined, scope: PlatformScope) =>
  !!scopes && (scopes.includes('*') || scopes.includes(scope));

export function visibleAdminTabs(scopes: string[] | undefined): AdminTab[] {
  return ADMIN_TABS.filter((t) => hasScope(scopes, t.scope));
}

/** Aba correspondente ao caminho atual — a mais específica que casar. */
export function adminTabForPath(pathname: string): AdminTab | undefined {
  return ADMIN_TABS.filter((t) => (t.href === '/admin' ? pathname === '/admin' : pathname.startsWith(t.href))).sort(
    (a, b) => b.href.length - a.href.length,
  )[0];
}

/**
 * Caminho dentro de /admin sem aba conhecida é tratado como área nova: só o
 * master entra, igual ao fail-closed do guard no backend.
 */
export function canSeeAdminPath(pathname: string, scopes: string[] | undefined): boolean {
  const tab = adminTabForPath(pathname);
  if (!tab) return !!scopes?.includes('*');
  return hasScope(scopes, tab.scope);
}

export function firstAllowedAdminHref(scopes: string[] | undefined): string | undefined {
  return visibleAdminTabs(scopes)[0]?.href;
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run (cwd `apps/web`): `npx jest src/lib/admin-tabs.spec.ts`
Expected: PASS, 13 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/admin-tabs.ts apps/web/src/lib/admin-tabs.spec.ts
git commit -m "feat(web): regras puras de visibilidade das abas do admin"
```

---

### Task 7: Ligar os escopos na interface

**Files:**
- Modify: `apps/web/src/stores/auth.store.ts:4-12`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx:73-93`
- Modify: `apps/web/src/app/(dashboard)/admin/layout.tsx`

**Interfaces:**
- Consumes: `platform_scopes` de `/auth/me` (Task 5); `visibleAdminTabs`, `canSeeAdminPath`, `firstAllowedAdminHref` (Task 6).
- Produces: `useAuthStore().user.platform_scopes?: string[]`.

- [ ] **Step 1: Adicionar o campo ao store**

Em `apps/web/src/stores/auth.store.ts`, na interface `User`:

```ts
interface User {
  id: string;
  nome: string;
  email: string;
  role: string;
  tenantId: string;
  avatar_url?: string;
  is_platform_admin?: boolean;
  /** ["*"] = admin master; senão as áreas liberadas do painel. */
  platform_scopes?: string[];
}
```

- [ ] **Step 2: Propagar do `/auth/me`**

Em `apps/web/src/app/(dashboard)/layout.tsx`, nos dois ramos do sync, acrescentar o campo:

```ts
            restoreUser({
              id: u.id,
              nome: u.nome,
              email: u.email,
              role: u.role,
              tenantId: data.tenant?.id ?? '',
              avatar_url: u.avatar_url,
              is_platform_admin: u.is_platform_admin,
              platform_scopes: u.platform_scopes,
            });
          } else {
            updateUser({
              is_platform_admin: u.is_platform_admin,
              platform_scopes: u.platform_scopes,
              nome: u.nome,
              avatar_url: u.avatar_url,
            });
```

- [ ] **Step 3: Reescrever o layout do admin**

Substituir o conteúdo de `apps/web/src/app/(dashboard)/admin/layout.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { PageHeader } from '@/components/layout/page-header';
import { visibleAdminTabs, canSeeAdminPath, firstAllowedAdminHref } from '@/lib/admin-tabs';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const isAdmin = useAuthStore((s) => s.user?.is_platform_admin);
  const scopes = useAuthStore((s) => s.user?.platform_scopes);
  const hydrated = useAuthStore((s) => s.hydrated);
  const router = useRouter();
  const pathname = usePathname();

  const tabs = visibleAdminTabs(scopes);
  const allowed = canSeeAdminPath(pathname, scopes);

  useEffect(() => {
    if (!hydrated) return;
    if (isAdmin === false) {
      router.replace('/dashboard');
      return;
    }
    // Escopos só chegam depois do /auth/me; enquanto undefined não redireciona,
    // senão o admin master seria chutado do painel no primeiro render.
    if (isAdmin && scopes && !allowed) {
      router.replace(firstAllowedAdminHref(scopes) ?? '/dashboard');
    }
  }, [hydrated, isAdmin, scopes, allowed, router]);

  if (isAdmin === false) return null;
  if (scopes && !allowed) return null;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader title="Painel Admin" subtitle="Administração da plataforma" />
      <nav className="flex gap-1 border-b" style={{ borderColor: 'var(--border-default)' }}>
        {tabs.map((t) => {
          const active = t.href === '/admin' ? pathname === '/admin' : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className="px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
              style={{
                borderColor: active ? 'var(--primary)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Build do frontend**

Run (cwd `apps/web`): `npm run build`
Expected: build conclui sem erro de tipo.

- [ ] **Step 5: Rodar os testes do frontend**

Run (cwd `apps/web`): `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/stores/auth.store.ts "apps/web/src/app/(dashboard)/layout.tsx" "apps/web/src/app/(dashboard)/admin/layout.tsx"
git commit -m "feat(web): painel admin mostra só as abas do escopo do usuário"
```

---

### Task 8: Conceder os escopos ao admin restrito

**Files:**
- Create: `apps/api/scripts/set-platform-scopes.cjs`

**Interfaces:**
- Consumes: coluna `platform_scopes` (Task 1).
- Produces: `lucasmilagres098@gmail.com` com `is_platform_admin = true` e `platform_scopes = ['health','announcements','ai']`.

- [ ] **Step 1: Escrever o script**

Criar `apps/api/scripts/set-platform-scopes.cjs`:

```js
// Concede escopos de admin de plataforma a um usuário.
// Uso: node scripts/set-platform-scopes.cjs <email> <escopo,escopo,...>
// Ex.:  node scripts/set-platform-scopes.cjs lucasmilagres098@gmail.com health,announcements,ai
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const VALID = ['*', 'health', 'announcements', 'ai'];
const email = process.argv[2];
const scopes = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  if (!email || scopes.length === 0) {
    console.error('Uso: node scripts/set-platform-scopes.cjs <email> <escopos separados por vírgula>');
    process.exit(1);
  }
  const invalidos = scopes.filter((s) => !VALID.includes(s));
  if (invalidos.length) {
    console.error('Escopo inválido:', invalidos.join(', '), '— válidos:', VALID.join(', '));
    process.exit(1);
  }
  const user = await p.user.findUnique({ where: { email }, select: { id: true, nome: true, tenant_id: true } });
  if (!user) {
    console.error('Usuário não encontrado:', email);
    process.exit(1);
  }
  const updated = await p.user.update({
    where: { id: user.id },
    data: { is_platform_admin: true, platform_scopes: scopes },
    select: { email: true, nome: true, is_platform_admin: true, platform_scopes: true, tenant_id: true },
  });
  console.log(JSON.stringify(updated, null, 2));
  await p.$disconnect();
})().catch(async (e) => {
  console.error('ERRO', e.message);
  await p.$disconnect();
  process.exit(1);
});
```

- [ ] **Step 2: Rodar para o admin restrito**

Run (cwd `apps/api`): `node scripts/set-platform-scopes.cjs lucasmilagres098@gmail.com health,announcements,ai`
Expected: imprime o usuário com `"is_platform_admin": true` e `"platform_scopes": ["health","announcements","ai"]`.

- [ ] **Step 3: Confirmar que o master continua intacto**

Run (cwd `apps/api`):

```bash
node -e "require('dotenv').config();const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.user.findMany({where:{is_platform_admin:true},select:{email:true,platform_scopes:true,tenant_id:true}}).then(r=>{console.log(r);return p.\$disconnect()})"
```

Expected: `yurilinsofc@gmail.com` com `[ '*' ]` e `lucasmilagres098@gmail.com` com os três escopos.

- [ ] **Step 4: Verificação manual ponta a ponta**

Com a API e o web rodando, logar como `lucasmilagres098@gmail.com` (senha `Teste@123`) e conferir:

1. `/admin` redireciona para `/admin/health`.
2. A barra de abas mostra apenas Saúde, Avisos e IA.
3. `GET /api/platform-admin/stats` com o token dele responde 403.
4. `POST /api/platform-admin/announcements` com `target_tenant_id` do tenant do Yuri responde 403.
5. `GET /api/platform-admin/health` e `GET /api/ai/models` respondem 200.

Logar como Yuri e conferir que as seis abas continuam aparecendo e que Clientes, Logs e impersonate seguem funcionando.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/set-platform-scopes.cjs
git commit -m "chore(api): script para conceder escopos de admin de plataforma"
```

---

## Ordem de deploy

A coluna e o backfill (Task 1) precisam estar no banco **antes** do código novo do guard subir. Depois disso a ordem é a normal: deploy do backend, deploy do frontend, e por último o script da Task 8 concedendo os escopos ao admin restrito.
