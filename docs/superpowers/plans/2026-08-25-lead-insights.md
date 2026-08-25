# Ficha inteligente do lead + Radar comercial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM local (Ollama qwen2.5:3b na VPS) gera por lead: resumo da conversa, memória do relacionamento, próxima ação (data+motivo) e msg sugerida — exibidos no drawer do lead e numa página `/radar` ("quem chamar hoje").

**Architecture:** tabela nova `LeadInsight`; fila BullMQ `lead-insights` com `concurrency: 1`; worker usa `AiProviderService.chat()` (adapter `openai_compatible` já existente apontando para Ollama); gatilho no ponto pós-persist do inbound; cron de varredura; endpoints REST; card no `LeadDetailDrawer` + página `/radar`. Spec: `docs/superpowers/specs/2026-08-25-lead-insights-design.md`.

**Tech Stack:** NestJS + Prisma + BullMQ + @nestjs/schedule; Next.js 14 + TanStack Query + shadcn; Ollama (docker, API OpenAI-compatible). Jest API cobre tudo que é puro/service; jest web só `lib/`.

## Global Constraints

- NUNCA `prisma migrate deploy`/`db push` — migration = SQL manual em `apps/api/prisma/manual/`, aplicada via node+Prisma no container (runbook Task 8).
- NUNCA `any`. Jest API: `cd apps/api && npx jest <alvo> --maxWorkers=2` (RAM 16GB). Typecheck `npx tsc --noEmit` nos dois apps; `npm run build` no web antes de commit de tela.
- rtk hook quebra `npx prisma` — usar `node ../../node_modules/prisma/build/index.js generate`.
- Fila de LLM: `concurrency: 1`, `attempts: 2`. Prompt: máx 40 mensagens; saída JSON estrita sanitizada (modelo 3B suja JSON).
- Visibilidade: radar aplica `buildVisibilityWhere` (lead-visibility.ts:29) — OPERADOR vê só os dele.
- Memória do insight é ACUMULATIVA: novos fatos são mesclados aos existentes, nunca substituem o array inteiro.
- Branch `feat/lead-insights` de `master`. Commits `feat(api):`/`feat(web):`/`chore(deploy):`.
- A IA NUNCA envia mensagem ao cliente — só sugere.

---

### Task 1: Migration + schema — LeadInsight e AiFeature.insights

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (enum `AiFeature`; model novo após `LeadView` ~l.679)
- Create: `apps/api/prisma/manual/2026-08-25-lead-insight.sql`

**Interfaces:**
- Produces: Prisma Client com `prisma.leadInsight` e `AiFeature.insights` (Tasks 3-5 dependem).

- [ ] **Step 1: Branch** — `git checkout master && git pull origin master && git checkout -b feat/lead-insights`

- [ ] **Step 2: schema.prisma** — no enum `AiFeature`, acrescentar `insights`. Após o model `LeadView`:

```prisma
// Ficha inteligente do lead (spec 2026-08-25-lead-insights). Gerada por LLM
// local em fila; memoria e acumulativa entre geracoes.
model LeadInsight {
  id                        String    @id @default(uuid())
  tenant_id                 String
  tenant                    Tenant    @relation(fields: [tenant_id], references: [id], onDelete: Cascade)
  lead_id                   String    @unique
  lead                      Lead      @relation(fields: [lead_id], references: [id], onDelete: Cascade)
  resumo                    String    @default("")
  memoria                   Json      @default("[]") // [{ fato: string, quando_dito: string }]
  proxima_acao_at           DateTime?
  proxima_acao_motivo       String    @default("")
  msg_sugerida              String    @default("")
  ultima_msg_processada_at  DateTime?
  geracoes                  Int       @default(0)
  created_at                DateTime  @default(now())
  updated_at                DateTime  @updatedAt

  @@index([tenant_id])
  @@index([tenant_id, proxima_acao_at])
}
```

Acrescentar os lados inversos: `lead_insight LeadInsight?` no model `Lead` e `lead_insights LeadInsight[]` no model `Tenant`.

- [ ] **Step 3: SQL manual** `apps/api/prisma/manual/2026-08-25-lead-insight.sql`:

```sql
-- ALTER TYPE ... ADD VALUE nao roda dentro de transacao: statement isolado.
ALTER TYPE "AiFeature" ADD VALUE IF NOT EXISTS 'insights';

BEGIN;
CREATE TABLE IF NOT EXISTS "LeadInsight" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "lead_id" TEXT NOT NULL UNIQUE REFERENCES "Lead"("id") ON DELETE CASCADE,
  "resumo" TEXT NOT NULL DEFAULT '',
  "memoria" JSONB NOT NULL DEFAULT '[]',
  "proxima_acao_at" TIMESTAMP(3),
  "proxima_acao_motivo" TEXT NOT NULL DEFAULT '',
  "msg_sugerida" TEXT NOT NULL DEFAULT '',
  "ultima_msg_processada_at" TIMESTAMP(3),
  "geracoes" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "LeadInsight_tenant_id_idx" ON "LeadInsight"("tenant_id");
CREATE INDEX IF NOT EXISTS "LeadInsight_tenant_id_proxima_acao_at_idx" ON "LeadInsight"("tenant_id", "proxima_acao_at");
COMMIT;
```

- [ ] **Step 4:** `cd apps/api && node ../../node_modules/prisma/build/index.js generate && npx tsc --noEmit` — exit 0.
- [ ] **Step 5: Commit** — `git add apps/api/prisma && git commit -m "feat(api): tabela LeadInsight + feature insights (SQL manual)"`

---

### Task 2: base_url aceita host interno http (Ollama)

**Files:**
- Modify: `apps/api/src/modules/ai/ai.dto.ts` (validador ~l.44-55, `DEFAULT_ALLOWED_AI_HOSTS` l.14, `allowedAiHosts()` l.26)
- Test: `apps/api/src/modules/ai/ai-dto-base-url.spec.ts` (acrescentar describe)

**Interfaces:**
- Produces: cadastro de modelo com `base_url: 'http://ollama:11434/v1'` passa na validação; qualquer outro `http://` segue recusado.

- [ ] **Step 1: Failing test** — acrescentar ao spec existente (copiar o padrão de chamada do validador usado lá):

```typescript
describe('hosts internos http (LLM local)', () => {
  it('aceita http://ollama:11434/v1 (host interno allowlistado)', () => {
    expect(isValidBaseUrl('http://ollama:11434/v1')).toBe(true);
  });
  it('recusa http em host externo mesmo allowlistado', () => {
    expect(isValidBaseUrl('http://api.openai.com/v1')).toBe(false);
  });
  it('recusa host interno nao listado', () => {
    expect(isValidBaseUrl('http://redis:6379')).toBe(false);
  });
});
```

(`isValidBaseUrl` = o nome real da função validadora no arquivo — conferir e usar o existente; se a validação for inline no zod refine, exportá-la como função nomeada para testar, mantendo o schema usando-a.)

- [ ] **Step 2: Run** — `npx jest ai-dto-base-url --maxWorkers=2` — FAIL.

- [ ] **Step 3: Implementar** — em `ai.dto.ts`:

```typescript
/**
 * Hosts internos da rede docker autorizados a usar http (LLM local).
 * http so e aceito para ESTES hosts; todo host externo segue exigindo https.
 * Env AI_ALLOWED_INTERNAL_HOSTS (csv) substitui a lista, como AI_ALLOWED_HOSTS.
 */
const DEFAULT_INTERNAL_AI_HOSTS = ['ollama'];
export function allowedInternalAiHosts(): string[] {
  const raw = process.env.AI_ALLOWED_INTERNAL_HOSTS;
  if (!raw) return DEFAULT_INTERNAL_AI_HOSTS;
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}
```

No validador: se `parsed.protocol === 'http:'`, retorna `allowedInternalAiHosts().includes(parsed.hostname.toLowerCase())`; se `https:`, mantém o fluxo atual (allowlist externa); qualquer outro protocolo, false.

- [ ] **Step 4: Run** — `npx jest ai-dto-base-url --maxWorkers=2 && npx tsc --noEmit` — PASS/0.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/ai/ && git commit -m "feat(api): base_url http para hosts internos allowlistados (ollama)"`

---

### Task 3: Lib pura — prompt builder e sanitizador do JSON do modelo

**Files:**
- Create: `apps/api/src/modules/lead-insights/insight-prompt.ts`
- Create: `apps/api/src/modules/lead-insights/insight-prompt.spec.ts`

**Interfaces:**
- Consumes: `AiChatMessage` de `../ai/ai.types` (`{ role: 'system'|'user'|'assistant'; content: string }`).
- Produces (Task 4 consome):

```typescript
export interface InsightContexto {
  lead: { nome: string | null; telefone: string | null; etapa: string; temperatura: string; valor_estimado: number | null; ultima_interacao: Date | null };
  insightAnterior: { resumo: string; memoria: MemoriaFato[] } | null;
  mensagens: Array<{ de: 'cliente' | 'equipe'; texto: string; em: Date }>; // ja limitadas a 40 pelo chamador
}
export interface MemoriaFato { fato: string; quando_dito: string }
export interface InsightGerado {
  resumo: string;
  memoria_novos_fatos: MemoriaFato[];
  proxima_acao_em_dias: number; // clamp 1..30
  proxima_acao_motivo: string;
  msg_sugerida: string;
}
export function montarPromptInsight(ctx: InsightContexto): AiChatMessage[]
export function extrairInsight(textoModelo: string): InsightGerado | null  // parse defensivo
export function mesclarMemoria(atual: MemoriaFato[], novos: MemoriaFato[]): MemoriaFato[] // dedupe por fato normalizado, cap 30 itens
```

- [ ] **Step 1: Failing tests** (o sanitizador é o coração — cobrir sujeira real de modelo 3B):

```typescript
import { extrairInsight, mesclarMemoria, montarPromptInsight } from './insight-prompt';

describe('extrairInsight', () => {
  const valido = JSON.stringify({
    resumo: 'Cliente pediu prazo de entrega.',
    memoria_novos_fatos: [{ fato: 'aniversário do filho dia 22', quando_dito: '2026-08-20' }],
    proxima_acao_em_dias: 3,
    proxima_acao_motivo: 'ficou de confirmar metragem',
    msg_sugerida: 'Oi! Conseguiu conferir a metragem?',
  });

  it('JSON limpo passa', () => {
    const r = extrairInsight(valido);
    expect(r?.resumo).toContain('prazo');
    expect(r?.proxima_acao_em_dias).toBe(3);
  });

  it('JSON embrulhado em texto/markdown e extraido', () => {
    expect(extrairInsight('Claro! Aqui está:\n```json\n' + valido + '\n```\nEspero ter ajudado.')).not.toBeNull();
  });

  it('dias fora do dominio clampa 1..30; nao-numero vira 7 (default)', () => {
    const base = JSON.parse(valido);
    expect(extrairInsight(JSON.stringify({ ...base, proxima_acao_em_dias: 90 }))?.proxima_acao_em_dias).toBe(30);
    expect(extrairInsight(JSON.stringify({ ...base, proxima_acao_em_dias: 0 }))?.proxima_acao_em_dias).toBe(1);
    expect(extrairInsight(JSON.stringify({ ...base, proxima_acao_em_dias: 'logo' }))?.proxima_acao_em_dias).toBe(7);
  });

  it('campos texto truncados (resumo 800, motivo 200, msg 500) e strings coeridas', () => {
    const base = JSON.parse(valido);
    const r = extrairInsight(JSON.stringify({ ...base, resumo: 'x'.repeat(2000), msg_sugerida: 42 }));
    expect(r?.resumo.length).toBe(800);
    expect(r?.msg_sugerida).toBe(''); // nao-string vira vazio, nao derruba
  });

  it('memoria suja: itens nao-objeto/fato vazio somem', () => {
    const base = JSON.parse(valido);
    const r = extrairInsight(JSON.stringify({ ...base, memoria_novos_fatos: [42, { fato: '' }, { fato: 'obra nova' }] }));
    expect(r?.memoria_novos_fatos).toEqual([{ fato: 'obra nova', quando_dito: '' }]);
  });

  it('sem JSON algum -> null', () => {
    expect(extrairInsight('nao sei responder')).toBeNull();
  });
});

describe('mesclarMemoria', () => {
  it('dedupe por fato normalizado (caixa/acentos), mantem ordem, cap 30', () => {
    const atual = [{ fato: 'Obra no Niterói', quando_dito: '2026-08-01' }];
    const novos = [{ fato: 'obra no niteroi', quando_dito: '2026-08-20' }, { fato: 'gripe', quando_dito: '2026-08-20' }];
    const r = mesclarMemoria(atual, novos);
    expect(r).toHaveLength(2);
    expect(r[0].quando_dito).toBe('2026-08-01'); // primeiro registro vence
  });
});

describe('montarPromptInsight', () => {
  it('system exige JSON e proibe responder pelo cliente; user carrega lead, memoria e mensagens', () => {
    const msgs = montarPromptInsight({
      lead: { nome: 'Ana', telefone: '55999', etapa: 'Consulta', temperatura: 'MORNO', valor_estimado: 1500, ultima_interacao: new Date('2026-08-20') },
      insightAnterior: { resumo: 'antigo', memoria: [{ fato: 'gripe', quando_dito: '2026-08-10' }] },
      mensagens: [{ de: 'cliente', texto: 'quero orçamento', em: new Date('2026-08-20') }],
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/JSON/);
    expect(msgs[1].content).toContain('Ana');
    expect(msgs[1].content).toContain('gripe');
    expect(msgs[1].content).toContain('quero orçamento');
  });
});
```

- [ ] **Step 2: Run** — `npx jest insight-prompt --maxWorkers=2` — FAIL (module not found).

- [ ] **Step 3: Implementar** — pontos obrigatórios: system prompt em pt-BR pedindo APENAS o objeto JSON com as 5 chaves (dar o shape literal), instruindo: resumo 2-4 frases; fatos pessoais/comerciais ditos pelo cliente; dias até o próximo contato razoável pelo ritmo da conversa; msg curta e natural com a identidade de quem atende (sem "sou uma IA"). `extrairInsight`: achar primeiro `{` e último `}` do texto, `JSON.parse` em try/catch, coerção campo a campo (não-string → `''`; truncar 800/200/500; dias `Math.round` clamp 1..30, default 7 se NaN), memória filtrada. `mesclarMemoria`: normalizar com `normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim()`, `slice(0, 30)`.

- [ ] **Step 4: Run** — `npx jest insight-prompt --maxWorkers=2 && npx tsc --noEmit` — PASS/0.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/lead-insights/ && git commit -m "feat(api): prompt e sanitizador puros do insight de lead"`

---

### Task 4: Módulo lead-insights — fila, worker, gatilho, cron, endpoints

**Files:**
- Create: `apps/api/src/modules/lead-insights/lead-insights.queue.ts` (`export const LEAD_INSIGHTS_QUEUE = 'lead-insights';`)
- Create: `apps/api/src/modules/lead-insights/lead-insights.service.ts`
- Create: `apps/api/src/modules/lead-insights/lead-insights.processor.ts`
- Create: `apps/api/src/modules/lead-insights/lead-insights.controller.ts`
- Create: `apps/api/src/modules/lead-insights/lead-insights.module.ts`
- Test: `apps/api/src/modules/lead-insights/lead-insights.service.spec.ts`
- Modify: `apps/api/src/app.module.ts` (registrar módulo, junto de AiModule ~l.129)
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts` (~l.853-863, ao lado do dispatch de outbound-webhooks)

**Interfaces:**
- Consumes: Task 1 (`prisma.leadInsight`), Task 3 (as 3 funções), `AiProviderService.chat({ feature: AiFeature.insights, messages, tenantId, leadId })` (ai-provider.service.ts:65), `isWithinBroadcastWindow` (broadcast-window.ts:23), padrão de módulo BullMQ de `outbound-webhooks.module.ts:10-28`.
- Produces: `GET /api/leads/:id/insight`, `POST /api/leads/:id/insight/refresh`; `LeadInsightsService.enfileirarSeElegivel(leadId, tenantId)` chamado pelo inbound.

- [ ] **Step 1: Failing tests do service** (mock de prisma/queue no padrão dos specs do módulo outbound-webhooks — copiar a construção):

```typescript
describe('enfileirarSeElegivel', () => {
  it('enfileira com >=5 mensagens novas desde o watermark', async () => { /* prisma.message.count -> 5; expect queue.add com jobId lead-<id> e delay 120000 */ });
  it('enfileira com 1 nova e watermark ha mais de 12h', async () => { /* count -> 1, insight.ultima_msg_processada_at = now-13h */ });
  it('nao enfileira com 2 novas e watermark recente', async () => { /* count -> 2, watermark now-1h; queue.add nao chamado */ });
});
describe('gerarInsight (worker)', () => {
  it('feliz: chama ai.chat, grava upsert com memoria mesclada e watermark = ultima msg', async () => { /* ai.chat -> JSON valido; expect leadInsight.upsert */ });
  it('parse falha 2x: mantem insight anterior, incrementa nada, loga', async () => { /* ai.chat -> 'lixo' 2x; upsert NAO chamado */ });
  it('proxima_acao_at respeita janela do tenant (dia fora da janela empurra para o proximo dia util da janela)', async () => { /* tenant window seg-sex 9-18; dias=1 caindo sabado -> segunda 9h */ });
});
describe('refresh', () => {
  it('rate limit: segunda chamada em <5min recusa 429', async () => {});
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implementar.** Regras não óbvias:
  - Fila: `BullModule.registerQueue({ name: LEAD_INSIGHTS_QUEUE })`; processor `@Processor(LEAD_INSIGHTS_QUEUE, { concurrency: 1 })` extends `WorkerHost` (padrão outbound-webhooks.processor.ts:10); `@OnWorkerEvent('failed')` logando (padrão webhook.processor.ts:24).
  - `enfileirarSeElegivel`: conta `prisma.message.count({ where: { lead_id, created_at: { gt: watermark ?? epoch } } })`; regra ≥5 OU (≥1 e watermark >12h); `queue.add('gerar', { leadId, tenantId }, { jobId: 'lead-' + leadId, delay: 120_000, attempts: 2 })` — jobId deduplica rajada.
  - Worker `gerarInsight`: carrega lead (com estagio, tenant), últimas 40 mensagens asc, insight anterior; monta contexto (Task 3), `ai.chat({ feature: AiFeature.insights, messages, tenantId, leadId, opts: { temperature: 0.4, maxTokens: 700 } })`; `extrairInsight`; se null → retry 1x com mensagem extra "Responda SOMENTE o objeto JSON."; se null de novo → return sem gravar (job conta como sucesso; log warn). Grava upsert: memoria = `mesclarMemoria(anterior, novos)`, `proxima_acao_at` = now + dias, ajustada por `isWithinBroadcastWindow` do tenant (avançar de hora em hora até cair dentro — máx 7 dias de busca), `ultima_msg_processada_at` = created_at da última mensagem processada, `geracoes: { increment: 1 }`.
  - Cron: `@Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'America/Sao_Paulo' })` — leads com mensagem nos últimos 30 dias e insight `updated_at` > 7 dias (ou inexistente com ≥5 mensagens) → enfileira em lotes de 50 com delay escalonado (i * 30s) para não enfileirar rajada.
  - Controller: rotas sob o guard/padrão dos controllers de lead existentes (conferir decorators do leads.controller e replicar); `GET /leads/:id/insight` confere tenant do lead = tenant do user e visibilidade (OPERADOR só o dele — reusar a checagem que o módulo de leads usa para detalhe); refresh com rate limit em memória (Map leadId→timestamp).
  - Gatilho no inbound (inbound-message.service.ts, bloco ~l.853): `if (tenantId && !backfill && !isFromMe) { this.leadInsights.enfileirarSeElegivel(lead.id, tenantId).catch((e) => this.logger.warn(...)); }` — injetar service via módulo `@Global` ou import direto (seguir o padrão do broadcastReply/outboundWebhooks já injetados ali).

- [ ] **Step 4: Run** — `npx jest lead-insights --maxWorkers=2 && npx tsc --noEmit` — PASS/0. Rodar também `npx jest inbound --maxWorkers=2` (o arquivo tocado tem suite).
- [ ] **Step 5: Commit** — `git add apps/api/src && git commit -m "feat(api): modulo lead-insights (fila LLM local, gatilho inbound, cron, endpoints)"`

---

### Task 5: Endpoint do Radar

**Files:**
- Modify: `apps/api/src/modules/lead-insights/lead-insights.service.ts` + controller
- Test: `apps/api/src/modules/lead-insights/radar.spec.ts`

**Interfaces:**
- Consumes: `buildVisibilityWhere` (lead-visibility.ts:29, shape `{ userId, role, poolEnabled }`), `Stage.is_won/is_lost`.
- Produces: `GET /api/insights/radar` → `{ chamar_hoje: RadarItem[], promissores: RadarItem[], esfriando: RadarItem[] }`; `RadarItem = { lead_id, nome, telefone, etapa, temperatura, ultima_interacao, motivo, msg_sugerida, proxima_acao_at }`.

- [ ] **Step 1: Failing tests** — mock prisma; casos: (a) lead com `proxima_acao_at <= now` entra em chamar_hoje ordenado por mais atrasado; (b) QUENTE sem interação ≥2 dias entra em promissores (e NÃO duplica se já está em chamar_hoje — dedupe por lead_id com precedência chamar_hoje > promissores > esfriando); (c) ≥7 dias sem interação e estágio ativo entra em esfriando; estágio `is_won`/`is_lost` NUNCA aparece; (d) OPERADOR: where recebe `responsavel_id = userId` (asserção no argumento do findMany); (e) caps: 30 por seção.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implementar** — 3 queries `lead.findMany` com `where` base `{ tenant_id, estagio: { is_won: false, is_lost: false }, ...buildVisibilityWhere({...}) }` + condição da seção, `include { lead_insight, estagio }`, `take: 30`; montar motivo: do insight (`proxima_acao_motivo`) ou derivado ("QUENTE sem contato há N dias" / "sem contato há N dias"). Dedupe entre seções.
- [ ] **Step 4: Run** — `npx jest radar lead-insights --maxWorkers=2 && npx tsc --noEmit` — PASS/0.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): radar comercial (chamar hoje, promissores, esfriando)"`

---

### Task 6: Card "Inteligência" no drawer do lead + "Usar" no composer

**Files:**
- Create: `apps/web/src/components/leads/insight-card.tsx`
- Modify: `apps/web/src/components/kanban/lead-detail-drawer.tsx` (renderizar o card no topo do corpo; prop nova opcional `onUsarMensagem?: (texto: string) => void`)
- Modify: `apps/web/src/app/(dashboard)/chat/[id]/page.tsx` (~l.1068: passar `onUsarMensagem={setFollowupComposerText}` — state já existe na l.119 e alimenta `initialText` do composer na l.1055)

**Interfaces:**
- Consumes: Task 4 endpoints; padrão visual dos cards do drawer.
- Produces: `InsightCard({ leadId, onUsarMensagem }: { leadId: string; onUsarMensagem?: (t: string) => void })`.

- [ ] **Step 1: `insight-card.tsx`** — `useQuery(['lead-insight', leadId], GET /api/leads/:id/insight, retry: false)`; 404 → estado "Ainda não gerado" com botão "Gerar agora" (POST refresh → toast "Na fila — pronto em alguns minutos" + invalidate após 60s). Com dados: resumo; memória como lista compacta (`fato` + `quando_dito`); linha "Próximo contato: <data> — <motivo>"; bloco msg sugerida com botões **Usar** (chama `onUsarMensagem` se presente; senão `navigator.clipboard.writeText` + toast "Copiada") e **Regenerar** (refresh, disabled 5min via estado local). Rótulos pt-BR; skeleton no loading.
- [ ] **Step 2: Integrar no drawer** — card no topo, colapsável (padrão dos blocos do drawer — conferir e seguir). Prop `onUsarMensagem` repassada. No kanban (sem composer) o botão vira "Copiar" automaticamente (ausência da prop).
- [ ] **Step 3:** `cd apps/web && npx tsc --noEmit && npm run build` — 0/0.
- [ ] **Step 4: Commit** — `git add apps/web/src && git commit -m "feat(web): card Inteligencia no drawer do lead com msg sugerida no composer"`

---

### Task 7: Página /radar + navegação

**Files:**
- Create: `apps/web/src/app/(dashboard)/radar/page.tsx`
- Modify: `apps/web/src/components/layout/sidebar.tsx` (NAV_ITEMS l.19-31: inserir `{ href: '/radar', label: 'Radar', icon: Radar }` após Kanban; `Radar` de lucide-react) — palette ganha o item de graça.

**Interfaces:**
- Consumes: Task 5 (`GET /api/insights/radar`), padrão de página de `followup/page.tsx` (`'use client'` + PageHeader + react-query + sonner).
- Produces: rota `/radar`.

- [ ] **Step 1: `page.tsx`** — `useQuery(['radar'], staleTime 60s)`. KPI topo: "X para chamar hoje". Três seções na ordem chamar_hoje ("Chamar hoje"), promissores ("Promissores"), esfriando ("Esfriando") — cada card: nome (link `/chat/:id`), telefone, etapa+temperatura (badge, cores do kanban: FRIO cinza/MORNO amarelo/QUENTE laranja/MUITO_QUENTE vermelho), "há N dias sem contato", motivo, msg sugerida truncada com botão copiar, botão "Abrir conversa" (`router.push('/chat/'+lead_id)`). Seção vazia: texto neutro ("Ninguém por aqui 🎉" só na chamar_hoje; nas outras, "—"). Refresh manual no header (invalidate).
- [ ] **Step 2:** `npx tsc --noEmit && npm run build` — 0/0.
- [ ] **Step 3: Commit** — `git add apps/web/src && git commit -m "feat(web): pagina Radar com listas de quem chamar"`

---

### Task 8: Deploy — Ollama + migration + backend + front + E2E

**Files:**
- Modify: `docker-compose.yml` (raiz — serviço novo na `crm-network`)

- [ ] **Step 1: Compose** — acrescentar:

```yaml
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    networks: [crm-network]
    volumes:
      - ollama-data:/root/.ollama
    deploy:
      resources:
        limits:
          memory: 3g
```

(+ `ollama-data:` em volumes). SEM porta publicada — só rede interna. Commit `chore(deploy): servico ollama no compose`.

- [ ] **Step 2: Suites finais** — API: `npx jest --maxWorkers=2 && npx tsc --noEmit`; web: `npx jest --maxWorkers=2 && npx tsc --noEmit && npm run build`.
- [ ] **Step 3: Merge SEM push ainda** — `git checkout master && git merge --no-ff feat/lead-insights`.
- [ ] **Step 4: Migration no VPS** — runbook: escrever `apply-lead-insight.js` no scratchpad (um `$executeRawUnsafe` por statement; o `ALTER TYPE` PRIMEIRO e fora de BEGIN; os CREATE são idempotentes), `scp` → `docker cp` → `docker exec crm-backend node /app/apply-lead-insight.js` → rm. (ssh: `/c/WINDOWS/System32/OpenSSH/ssh.exe crm-vps`.)
- [ ] **Step 5: Ollama no VPS** — `ssh crm-vps "cd /opt/crm-whatsapp && git stash list"`; push master ANTES (`git push origin master`), depois `ssh crm-vps "cd /opt/crm-whatsapp && git pull origin master && docker compose up -d ollama && docker exec ollama ollama pull qwen2.5:3b-instruct-q4_K_M"` (~2GB de download; disco tem 53G). Conferir RAM: `free -h` — se disponível <1GB após subir, PARAR e reportar.
- [ ] **Step 6: Backend** — `ssh crm-vps "cd /opt/crm-whatsapp && docker compose build crm-backend && docker compose up -d crm-backend"`; health 200. Smoke do Ollama de dentro da rede: `docker exec crm-backend wget -qO- http://ollama:11434/v1/models`.
- [ ] **Step 7: Cadastro do modelo** — via painel `/admin/ai` em produção (super admin): provider `openai_compatible`, base_url `http://ollama:11434/v1`, model_id `qwen2.5:3b-instruct-q4_K_M`, api_key dummy (`ollama`), max_tokens 700 — marcar como default SE não houver outro default em uso (conferir antes; se houver, deixar não-default e o worker usa `modelConfigId` explícito? NÃO — o worker usa o default. Decisão: se já existir default externo em uso, PARAR e perguntar ao usuário qual modelo deve atender os insights).
- [ ] **Step 8: E2E real** — mandar mensagem de teste para uma instância, esperar o delay de 2min + processamento, conferir: `GET /api/leads/:id/insight` responde; card aparece no drawer do chat; `/radar` lista; "Usar" preenche o composer. Medir duração do job no log (esperado 30-120s no 3B/CPU).
- [ ] **Step 9:** Atualizar memória do projeto.

---

## Self-review (feito na escrita)

- Spec coberto: tabela+enum (T1), allowlist http interno (T2), prompt/sanitizador/mescla (T3), fila+gatilho+cron+endpoints+janela do tenant (T4), radar com visibilidade e dedupe (T5), card no drawer com Usar/copiar (T6), página+nav (T7), deploy ordenado com checagem de RAM e decisão de modelo default (T8).
- Sem placeholders: testes com valores exatos; os pontos "conferir padrão do arquivo X" têm arquivo e linha.
- Tipos consistentes: `InsightGerado`/`MemoriaFato` (T3) usados no worker (T4); `RadarItem` (T5) consumido na página (T7); `AiFeature.insights` (T1) usado no chat() (T4).
- Riscos aceitos e registrados: modelo 3B pode gerar JSON inválido (caminho de falha mantém insight anterior); 2 vCPU → job lento é esperado e aceitável (fila serial); janela do tenant reusa broadcast_window (decisão de produto: mesmo horário comercial).
