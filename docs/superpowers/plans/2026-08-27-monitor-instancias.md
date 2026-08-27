# Monitor de instâncias + alertas ao admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cron de saúde a cada 5 min que confere o status real de cada instância no gateway, religa sozinha as recuperáveis e abre alerta (painel admin + notificação + push) quando só QR novo resolve. Spec: `docs/superpowers/specs/2026-08-27-monitor-instancias-design.md`.

**Architecture:** service novo `InstanceHealthService` (módulo `instances`) com `@Cron` de 5 min; tabela `InstanceAlert`; endpoint `GET /admin/instances-health` no platform-admin; seção "Instâncias" no front `/admin`. Webhook `connection.update` existente ganha o gancho de resolução de alerta.

**Tech Stack:** NestJS/@nestjs/schedule (`@Cron` já usado no módulo lead-insights e broadcasts — copiar padrão), Prisma, axios via HttpService (padrão do instances.service), web-push via `PushService.sendToUsers` (`apps/api/src/modules/push/push.service.ts:74`).

## Global Constraints

- NUNCA `any`. Jest `--maxWorkers=2`; tsc verde nos dois apps; `npm run build` no web.
- Migration manual idempotente em `apps/api/prisma/manual/` (padrão das fases 3-5), aplicada no VPS ANTES do backend.
- Gateway calls: timeout 5s; erro de rede = estado DESCONHECIDO (não alerta, não muda status no banco; debug log). Instâncias de tenant suspenso e provider WPPConnect legado (config sem uazapi_token e sem evolution_token) ficam FORA do cron.
- Anti-flap (spec verbatim): alerta só com "caída em 2 ciclos consecutivos (≥10 min) E sem alerta aberto". UM alerta por queda.
- Cron nunca derruba o processo: cada instância em try/catch individual; o loop segue.
- Texto humano nos avisos (sem jargão): "Instância {nome} ({tenant}) desconectada desde {HH:mm} — provavelmente precisa de QR novo." / "Instância {nome} ({tenant}) reconectou."
- Branch `feat/monitor-instancias` de `master`. Commits `feat(api):`/`feat(web):`.

---

### Task 1: Migration + schema — InstanceAlert

**Files:**
- Create: `apps/api/prisma/manual/2026-08-27-instance-alert.sql`
- Modify: `apps/api/prisma/schema.prisma` (model novo + inversas em Tenant `instance_alerts` e WhatsappInstance `alerts`)

**Interfaces:**
- Produces: model `InstanceAlert` — `id String @id @default(uuid())`, `tenant_id` (FK Tenant CASCADE), `instance_id` (FK WhatsappInstance CASCADE), `tipo String @default("desconectada")`, `aberto_em DateTime @default(now())`, `resolvido_em DateTime?`, `created_at @default(now())`, `updated_at @updatedAt`; `@@index([instance_id, resolvido_em])`, `@@index([resolvido_em, aberto_em])`.

- [ ] **Step 1: SQL idempotente** (cabeçalho padrão; BEGIN/COMMIT; CREATE TABLE IF NOT EXISTS com PK explícita; DO $$ p/ as 2 FKs `InstanceAlert_tenant_id_fkey`/`InstanceAlert_instance_id_fkey` ON DELETE CASCADE ON UPDATE CASCADE; 2 CREATE INDEX IF NOT EXISTS com nomes convenção Prisma `InstanceAlert_instance_id_resolvido_em_idx` e `InstanceAlert_resolvido_em_aberto_em_idx`; colunas TIMESTAMP(3), `updated_at` SEM default).
- [ ] **Step 2: schema.prisma** espelho exato + inversas. **Step 3:** validate + generate + tsc. **Step 4: Commit** — `feat(api): schema — tabela InstanceAlert (monitor de instancias)`

---

### Task 2: InstanceHealthService — cron, reconexão e alertas (TDD)

**Files:**
- Create: `apps/api/src/modules/instances/instance-health.service.ts`
- Modify: `apps/api/src/modules/instances/instances.module.ts` (provider novo; importar módulo do PushService se necessário)
- Modify: `apps/api/src/modules/webhooks/uazapi-events.handler.ts` e `evolution-events.handler.ts` (gancho de resolução no connection.update → open)
- Test: `apps/api/src/modules/instances/instance-health.service.spec.ts`

**Interfaces:**
- Consumes: Task 1; `PushService.sendToUsers(userIds, payload)`; padrões de chamada do gateway em `instances.service.ts` (`GET {UAZAPI_BASE_URL}/instance/status` header `{ token }`; `POST /instance/connect` header `{ token }`; Evolution `GET {base}/instance/connectionState/:nome` e `GET /instance/connect/:nome` header apikey) — reimplementar no service novo lendo `config.uazapi_token`/`config.evolution_token`/`config.evolution_base_url` (mesmo shape `InstanceConfig`).
- Produces: `InstanceHealthService.verificarTodas()` (chamada pelo `@Cron(CronExpression.EVERY_5_MINUTES)`) e `resolverAlerta(instanceId)` público (chamado pelos handlers de webhook na transição → open).

Estado de "ciclos consecutivos caída": em memória (`Map<instanceId, number>`) — reinício do processo zera e só atrasa um alerta em 5 min, aceitável e documentado.

- [ ] **Step 1: Failing tests** (mock Prisma + HttpService + PushService, fake timers onde precisar):
  - (a) instância UazAPI conectada no gateway → banco atualizado p/ open + ultimo_check; nenhuma reconexão/alerta;
  - (b) caída no 1º ciclo → tenta `POST /instance/connect`; resposta conectada → status open, SEM alerta;
  - (c) caída, connect devolve QR → continua caída; 1º ciclo NÃO alerta; 2º ciclo consecutivo → cria InstanceAlert + notification.create p/ CADA user is_platform_admin + sendToUsers com os mesmos ids; 3º ciclo → NÃO duplica (alerta aberto);
  - (d) recuperou no cron com alerta aberto → resolvido_em preenchido + notification de recuperação;
  - (e) `resolverAlerta` chamado pelo handler (transição close→open) resolve e notifica;
  - (f) tenant suspenso e instância sem token conhecido → puladas (gateway nem é chamado);
  - (g) erro de rede no status → nada muda no banco, sem alerta, loop continua para a próxima instância;
  - (h) Evolution: state close → connect tentado; mapeamento de state (open/connecting/close) correto.
- [ ] **Step 2: RED.** **Step 3: Implementar** (texto das notificações verbatim das Global Constraints; `Notification.create` com user_id de cada platform admin — conferir shape do model Notification antes; push payload `{ title: 'Instância desconectada', body: <mesmo texto>, url: '/admin' }` — conferir shape `PushPayload`).
- [ ] **Step 4: GREEN** (`npx jest instance-health --maxWorkers=2` + suíte instances + tsc). **Step 5: Commit** — `feat(api): monitor de instancias com auto-reconexao e alertas ao admin`

---

### Task 3: Endpoint admin — GET /admin/instances-health (TDD)

**Files:**
- Modify: `apps/api/src/modules/platform-admin/platform-admin.controller.ts`, `platform-admin.service.ts`
- Test: spec do módulo (padrão `platform-admin.scopes.spec.ts` inclui rota nova no mapa de escopos)

**Interfaces:**
- Consumes: Task 1.
- Produces: `GET /admin/instances-health` (guards do módulo; escopo — usar o mesmo padrão das rotas de leitura existentes, ex. o de `health`) → `{ instancias: Array<{ tenant: string; nome: string; provider: 'uazapi'|'evolution'|'legado'; status: string; ultimo_check: string | null; caida_desde: string | null }> }` — `caida_desde` = `aberto_em` do alerta aberto (null sem alerta); ordenado: alertas abertos primeiro (mais antigo primeiro), depois por tenant/nome. Tenants suspensos marcados ou excluídos — EXCLUÍDOS (spec: monitor ignora suspensos).

- [ ] **Step 1: Failing tests** (rota no mapa de escopos + shape/ordenação com mock). **Step 2: RED.** **Step 3: Implementar.** **Step 4: GREEN + tsc.** **Step 5: Commit** — `feat(api): visao de saude das instancias no admin`

---

### Task 4: Web — seção "Instâncias" no /admin (paralela à T3 após contrato)

**Files:**
- Modify: a página principal do admin (`apps/web/src/app/(dashboard)/admin/page.tsx` — conferir nome real; é onde ficam os cards de stats)

**Interfaces:**
- Consumes: `GET /api/admin/instances-health` (contrato da T3; backend velho sem a rota → seção some, `retry:false`, zero crash).

- [ ] **Step 1:** Seção "Instâncias" após os cards existentes: badge no título com contagem de caídas (`N caídas` em vermelho quando N>0; "todas conectadas" verde quando 0); tabela compacta: Tenant · Instância · Status (chip: verde open / amarelo connecting / vermelho disconnected|close) · Última checagem (relativa: "há 3 min") · Caída desde (dd/MM HH:mm, vermelho). Caídas no topo. useQuery `['admin-instances-health']` refetch 60s (parar em erro — padrão da financeira).
- [ ] **Step 2:** tsc + build 0 erros. **Step 3: Commit** — `feat(web): saude das instancias no painel admin`

---

### Task 5: Deploy + smoke

- [ ] Suítes API completas + build web; merge master (sem push) → push.
- [ ] VPS: aplicar SQL ANTES do backend (apply script padrão) → build/up → health 200, zero P2022.
- [ ] Smoke real: com a `atendimento-alex` ainda caída (se o cliente não tiver reconectado), em ≤10 min o cron deve tentar reconectar, abrir o alerta e a Notification aparecer para o Yuri; `GET /admin/instances-health` listando a caída no topo; conferir no painel.
- [ ] Memória.

---

## Self-review (feito na escrita)

- Spec coberta: cron+status real (T2a), auto-reconexão (T2b), anti-flap + alerta único + push (T2c), recuperação por cron e por webhook (T2d/e), exclusões (T2f), rede ≠ queda (T2g), Evolution (T2h), painel (T3+T4), tabela (T1).
- Sem placeholders; contrato T3=T4; textos de aviso fixados nas constraints.
- Riscos aceitos: contador anti-flap em memória (restart atrasa alerta em 1 ciclo — documentado); tenants suspensos fora do painel (spec); WPP legado fora (spec).
- Ordem: T1 → T2 → (T3 → T4, T4 pode iniciar após contrato da T3 estar no plano — arquivos disjuntos) → T5.
