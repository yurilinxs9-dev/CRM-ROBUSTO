# Revisão Completa + QA — CRM WhatsApp (jul/2026)

Escopo analisado: monorepo turbo (`apps/api` NestJS 10 + Prisma 5 + BullMQ/Redis + Socket.IO, `apps/web` Next 14 + React Query 5 + Zustand), 26 módulos backend, ~165 endpoints em 26 controllers, schema Prisma multi-tenant completo.

---

## 1. O que está BOM (manter)

| Área | Evidência |
|------|-----------|
| Segurança HTTP | `main.ts`: helmet, ValidationPipe `whitelist+forbidNonWhitelisted+transform`, CORS allowlist por env, body limit 1mb default (60mb só em media/messages) |
| Auth | bcrypt salt 12, refresh token com secret separado, throttle 5/min no login, auditoria de login (sucesso/falha + IP) |
| RBAC | `RolesGuard` com hierarquia SUPER_ADMIN>GERENTE>OPERADOR>VISUALIZADOR; `is_platform_admin` separado |
| Multi-tenant | `tenant_id` em todos os models, índices compostos `[tenant_id, ...]` |
| Webhooks | 100% assíncrono via BullMQ (regra crítica respeitada), upsert por `whatsapp_message_id` |
| API pública | scopes guard, `ApiRequestLog` por request, OpenAPI, keys com prefix+hash |
| IA | chaves AES-256-GCM em repouso, nunca retornadas, platform-scoped |
| Observabilidade | Sentry + pino estruturado + bull-board |
| Perf | trabalho recente sólido: delta-patch WS, paginação, índices parciais (dashboard 4.4s→264ms) |

---

## 2. Achados QA — CRÍTICOS

### 2.1 Zero testes automatizados (severidade: ALTA)
`find` retornou **0 arquivos** `.spec.ts`/`.test.ts` no monorepo inteiro. Jest está configurado mas nunca usado.
- Risco comprovado pelo histórico: bug do ack Evolution flat-object, recaída do `lead_scope`, mediaKey byte-map — todos regressões que teste de unidade pegaria.
- Alvos prioritários (maior ROI):
  1. `webhooks/message-extractor.ts` (439 l) — pura, fácil de testar, formatos UazAPI + Evolution
  2. `webhook.processor.ts` (1358 l) — normalização de acks, lead_scope, resolução @lid
  3. `leads.service.ts` (1398 l) — regras de visibilidade (pool/individual/setor/share_history)
  4. Round-robin `QueuePointer` (corrida)
  5. `auth.service.ts` — login/refresh/roles

### 2.2 Sem CI (severidade: ALTA)
Não existe `.github/workflows`. Nada roda lint/typecheck/build no push. Combinado com deploy manual tar+scp e a divergência prod↔GitHub já conhecida (15 commits, branch `vps-live`), é o maior risco operacional do projeto.

### 2.3 Refresh token não revogável (severidade: ALTA)
`refreshToken()` verifica JWT stateless — não há registro server-side. Consequências:
- Logout não invalida nada; token roubado vale até 7d (ou **365d** com remember)
- Sem rotação: o mesmo refresh pode ser reusado infinitas vezes dentro da validade
- Referência de mercado: rotação + reuse-detection (Auth0 pattern), família de tokens em Redis/DB

### 2.4 Migrations em estado quebrado (severidade: ALTA, já documentado)
`_prisma_migrations` poluído (~121 linhas, 47 unfinished), drift pré-existente. Processo manual via `migrate diff` funciona mas é frágil e não versionado com garantia. Precisa de baseline definitivo.

## 3. Achados QA — MÉDIOS

- **God files**: `leads.service.ts` 1398 l, `webhook.processor.ts` 1358 l, `analytics/page.tsx` 1191 l, `kanban/page.tsx` 1131 l, `chat/[id]/page.tsx` 1042 l. Custo real: toda mudança em visibilidade/kanban toca arquivo gigante sem teste.
- **JwtStrategy faz `findUnique` no banco a cada request** — correto (pega desativação na hora), mas é 1 roundtrip DB por request; cache curto (5-10s, Redis) manteria a semântica com fração do custo.
- **Throttler in-memory** — ok em container único; quebra se escalar horizontal (mover pra storage Redis).
- **Upload via JSON base64 60mb** passando pelo backend — mover pra upload direto ao Supabase Storage com signed URL (backend só emite URL + registra), corta RAM/CPU do Node e o limite de 60mb.
- **`createUser` com `$executeRaw` INSERT** — funciona (FK deferred), mas bypassa validação Prisma; documentar ou isolar.
- **Sem fluxo de reset de senha / sem 2FA / sem lockout progressivo** (throttle 5/min é o único freio a brute-force).
- **Sem healthcheck de fila** exposto (lag de BullMQ não alerta ninguém; bull-board é passivo).
- **Baileys/Evolution = API não-oficial** — risco permanente de ban/quebra (caso diplapel USync foi sintoma). Consolidados (Kommo, Take Blip, Zenvia) operam WhatsApp Cloud API oficial como tier premium.

## 4. Achados QA — MENORES

- TODOs reais pendentes: bulk drag no kanban (`kanban/page.tsx:586`), auto-actions em bulk move (`leads.service.ts:808`), histórico no time-in-stage (`analytics.service.ts:555`)
- `AdminAuditLog.admin_user_id = 'anonymous'` em login falho — smell de modelagem (campo deveria ser nullable)
- `docs/` mistura specs aiox com docs reais; `qr-evolution.png`, `relatorio-ordering.md` soltos na raiz
- CORS `methods` não inclui `PUT` — ok hoje (só PATCH), mas vai morder se alguém adicionar rota PUT

---

## 5. Benchmark — CRMs consolidados vs. nosso CRM

| Recurso | Kommo/amoCRM | HubSpot | Pipedrive | Chatwoot | **Nosso** |
|---|---|---|---|---|---|
| Kanban pipeline | ✅ | ✅ | ✅ | — | ✅ |
| Inbox WhatsApp multi-instância | ✅ | via app | via app | ✅ | ✅ |
| Automação por etapa (auto-actions, cadência, SLA) | ✅ Salesbot | ✅ Workflows | ✅ | ✅ macros | ✅ (parcial) |
| **Campos customizados por tenant** | ✅ | ✅ | ✅ | ✅ | ❌ (schema fixo) |
| **Dedupe/merge de contatos** | ✅ | ✅ | ✅ | — | ❌ (dedup só por telefone) |
| **Lead scoring automático** | ✅ | ✅ | ✅ | — | ❌ (temperatura manual) |
| **Notas internas + @menções na conversa** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Relatório funil/conversão por etapa + forecast** | ✅ | ✅ | ✅ Insights | — | parcial (analytics básico) |
| CSAT pós-atendimento | — | ✅ | — | ✅ | ❌ |
| Multi-canal (IG, Messenger, e-mail) | ✅ | ✅ | ✅ | ✅ | ❌ (só WhatsApp) |
| IA (copilot, sugestão, follow-up) | ✅ | ✅ | ✅ | ✅ | ✅ (na frente de vários) |
| API pública + webhooks | ✅ | ✅ | ✅ | ✅ | ✅ |
| Billing/planos/limites por tenant | ✅ | ✅ | ✅ | ✅ | ❌ (platform admin sem cobrança) |
| WhatsApp Cloud API oficial | ✅ | ✅ | ✅ | ✅ | ❌ (Baileys/UazAPI) |

Diferenciais que já temos e poucos têm nesse nicho BR: round-robin por setor com auditoria, share_history opt-in, IA provider-agnóstica com custo por chamada, migração de provider sem deploy.

---

## 6. PLANO — 4 fases

### Fase 0 — Fundação de qualidade (1-2 semanas) ⟵ começar aqui
1. **CI GitHub Actions**: lint + typecheck + build em todo push/PR (workflow único, ~30 min de setup)
2. **Harness de teste + primeiros testes**: message-extractor (tabela de payloads reais UazAPI/Evolution), normalização de ack, regras de visibilidade do leads.service. Meta: ~60 testes cobrindo os 3 hotspots
3. **Reconciliar prod↔GitHub** (pendência conhecida) e passar deploy backend pra script único versionado
4. **Baseline de migrations**: gerar baseline limpo, `migrate resolve` em massa, voltar a ter `migrate deploy` funcional
5. `npm audit` + atualização de deps com CVE

### Fase 1 — Segurança (1 semana)
1. Refresh token com **rotação + revogação** (tabela RefreshToken ou Redis; reuse-detection invalida família)
2. Logout server-side real
3. Fluxo esqueci-minha-senha (token por e-mail, expiração 1h)
4. Throttler storage Redis + lockout progressivo por conta (5 falhas → backoff)
5. `AdminAuditLog.admin_user_id` nullable

### Fase 2 — Refactor dirigido (1-2 semanas, incremental)
1. `leads.service.ts` → `leads-query.service` + `leads-command.service` + `lead-visibility.ts` (regras puras, testáveis)
2. `webhook.processor.ts` → 1 handler por evento (messages.upsert, messages.update, chats.update...)
3. Kanban/chat/analytics pages → extrair hooks + componentes (nada de página >400 linhas)
4. Upload direto ao Storage via signed URL (derruba limite 60mb do body)
5. Cache 5s do user no JwtStrategy

### Fase 3 — Paridade de mercado (produto, priorizar por demanda dos 4 atendentes)
1. **Campos customizados por tenant** (JSON schema-driven, filtros no kanban) — destrava vários verticais
2. **Notas internas + @menções** na conversa (Chatwoot pattern) — barato, alto impacto no time
3. **Dedupe/merge UI** (HubSpot pattern: sugerir por telefone/email/nome, merge preservando histórico)
4. **Relatórios**: conversão por etapa (funil real com LeadActivity), tempo médio por etapa, forecast por valor_estimado
5. **Lead scoring automático** (engajamento: resposta, recência, valor) alimentando temperatura
6. CSAT pós-fechamento via mensagem automática

### Fase 4 — Escala SaaS (quando fizer sentido comercial)
1. Billing (Stripe/Asaas) + planos + enforcement de limites (instâncias, usuários, mensagens/mês)
2. WhatsApp Cloud API oficial como 3º provider (gateway já é multi-provider — encaixa no design atual)
3. Multi-canal: Instagram DM (Cloud API cobre), e-mail
4. Métricas Prometheus + alertas (lag de fila, taxa FAILED, cert TLS)

### Ordem recomendada
Fase 0 é pré-requisito de tudo (sem teste+CI, cada feature nova re-arrisca regressão nos fluxos que já quebraram 3x). Fase 1 tem itens de risco real hoje (refresh 365d irrevogável). Fases 2-3 podem intercalar com demanda de produto.
