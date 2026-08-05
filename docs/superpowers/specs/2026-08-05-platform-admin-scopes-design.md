# Escopos do admin de plataforma

Data: 2026-08-05

## Problema

Hoje o acesso ao painel de plataforma é binário: `User.is_platform_admin` libera
tudo — visão geral, clientes, saúde, logs, avisos, IA, além de banir usuário,
excluir/suspender tenant e impersonar. Não há como conceder um subconjunto.

Precisamos de um segundo admin de plataforma (`lucasmilagres098@gmail.com`) que
enxergue apenas Saúde, Avisos e IA, e que em nenhuma hipótese alcance o tenant do
admin master.

## Solução

Manter `is_platform_admin` como portão de entrada e acrescentar uma lista de
escopos que diz *o que* dentro do painel cada admin pode fazer.

### 1. Schema

Nova coluna em `User`:

```prisma
platform_scopes String[] @default([])
```

- `["*"]` — admin master, acesso total (Yuri).
- `["health", "announcements", "ai"]` — admin restrito (lucas).
- `[]` — sem acesso a nenhuma rota escopada. Só relevante para um usuário com
  `is_platform_admin=true` e nenhum escopo, que fica efetivamente sem painel.

Escolhemos a lista de escopos em vez de um enum `platform_admin_level`
(`FULL`/`LIMITED`) porque o custo de migration é o mesmo e a lista permite criar
outro admin com uma combinação diferente sem alterar código.

### 2. Guard

`PlatformAdminGuard` continua lendo `is_platform_admin` e `ativo` do banco (não
do JWT, para que revogação tenha efeito imediato) e passa a ler também
`platform_scopes`. Um decorator novo declara o escopo exigido por rota ou
controller:

```ts
@PlatformScopes('health')
```

Regra de decisão:

1. Usuário não autenticado, inativo ou sem `is_platform_admin` — 403.
2. `platform_scopes` contém `*` — libera.
3. `platform_scopes` contém o escopo exigido — libera.
4. Caso contrário — 403.

Rota sem decorator exige `*`. O padrão é fail-closed: uma rota nova nasce
restrita ao master até que alguém decida conscientemente abri-la.

### 3. Mapa de rotas

| Rota | Escopo |
| --- | --- |
| `GET /platform-admin/health` | `health` |
| `GET /platform-admin/announcements` | `announcements` |
| `POST /platform-admin/announcements` | `announcements` |
| `PATCH /platform-admin/announcements/:id` | `announcements` |
| `GET /ai/models`, `POST /ai/models`, `PUT /ai/models/:id`, `DELETE /ai/models/:id`, `POST /ai/models/:id/test` | `ai` |
| `GET /ai/agent`, `PATCH /ai/agent` | `ai` |
| `GET /platform-admin/stats` | `*` |
| `GET /platform-admin/tenants`, `GET /platform-admin/tenants/:id` | `*` |
| `GET /platform-admin/logs` | `*` |
| `PATCH /platform-admin/users/:id/ban` | `*` |
| `DELETE /platform-admin/users/:id` | `*` |
| `DELETE /platform-admin/tenants/:id` | `*` |
| `PATCH /platform-admin/tenants/:id/suspend` | `*` |
| `POST /platform-admin/impersonate/:userId` | `*` |

As rotas de IA de atendente (`/ai/copilot`, `/ai/suggest-reply`) não usam
`PlatformAdminGuard` e ficam como estão.

### 4. Proteção do tenant master

"Tenant protegido" é o tenant de qualquer usuário ativo com `is_platform_admin`
e escopo `*`. A definição deriva do dado em vez de fixar um UUID, então continua
valendo se o admin master trocar de tenant.

Pontos de aplicação:

- `createAnnouncement` — `target_tenant_id` apontando para tenant protegido, com
  caller sem `*`, retorna 403.
- `setAnnouncementActive` — aviso cujo `target_tenant_id` é tenant protegido, com
  caller sem `*`, retorna 403.
- Helper `assertTenantAllowed(caller, tenantId)` em `PlatformAdminService`, para
  que rotas futuras que recebam `tenant_id` reusem a mesma checagem.

O admin restrito já não enxerga as abas Clientes e Logs nem o impersonate, então
essa proteção é a segunda tranca, não a única.

### 5. Frontend

- `AuthService.getMe` passa a devolver `platform_scopes`; `auth.store` guarda o
  campo junto de `is_platform_admin`.
- `apps/web/src/app/(dashboard)/admin/layout.tsx` — cada item de `TABS` ganha um
  campo `scope`, e a navegação renderiza só as abas cujo escopo o usuário tem
  (`*` vê todas). O redirect atual (`is_platform_admin === false` volta para
  `/dashboard`) permanece.
- Um admin restrito que abrir `/admin` (Visão geral) é redirecionado para a
  primeira aba permitida — no caso do lucas, `/admin/health`.
- A sidebar continua exibindo o link "Admin" com base em `is_platform_admin`.

### 6. Testes

- Guard: escopo `*` passa em rota escopada e em rota sem decorator; escopo exato
  passa; escopo ausente retorna 403; usuário sem decorator e sem `*` retorna 403;
  usuário inativo retorna 403.
- `createAnnouncement` com `target_tenant_id` de tenant protegido: 403 para
  caller sem `*`, sucesso para caller com `*`.
- `setAnnouncementActive` no mesmo cenário.
- Frontend: layout do admin renderiza só as abas permitidas e redireciona
  `/admin` para a primeira aba permitida.

### 7. Aplicação em produção

A migration adiciona apenas um objeto novo (`ALTER TABLE "User" ADD COLUMN
"platform_scopes" text[] NOT NULL DEFAULT '{}'`), sem tocar no drift
pré-existente. Segue o fluxo obrigatório do CLAUDE.md: gerar o SQL com
`prisma migrate diff`, remover qualquer statement não relacionado, aplicar em
transação e registrar com `prisma migrate resolve --applied`.

Depois da migration, um script pontual define:

- Yuri (`yurilinsofc@gmail.com`): `platform_scopes = ["*"]`.
- lucas (`lucasmilagres098@gmail.com`): `is_platform_admin = true` e
  `platform_scopes = ["health", "announcements", "ai"]`.

O default `'{}'` deixa qualquer outro usuário sem escopo, o que é inócuo porque
nenhum outro tem `is_platform_admin`.
