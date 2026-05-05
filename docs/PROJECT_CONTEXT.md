# Contexto do Projeto: CRM WhatsApp Multi-Instância

> Prompt de contexto completo para reiniciar sessões de desenvolvimento
> com assistentes AI. Cole o conteúdo deste arquivo como primeira
> mensagem em uma nova sessão para o assistente entrar com contexto
> total do projeto.

## Identidade
CRM multi-tenant integrado ao WhatsApp via UazAPI (ex-Evolution API),
com Kanban de leads, chat em tempo real, gerenciamento de múltiplas
instâncias WPP, pipelines/automações e mídia completa (áudio PTT,
foto, vídeo, documentos).

## Stack
- **Frontend:** Next.js 14 App Router + TypeScript → Vercel
- **Backend:** NestJS + Socket.IO → VPS Docker (187.127.11.117)
- **DB:** Supabase PostgreSQL + Supabase Storage
- **ORM:** Prisma (SEMPRE usar directUrl para migrations)
- **Filas:** BullMQ + Redis (container `crm-redis` em docker-compose)
- **WhatsApp:** UazAPI (webhooks + REST)
- **Observabilidade:** Pino logs + Sentry (DSN-gated)
- **Logs/headers:** Helmet + Pino com redaction

## Paths
- `C:\Users\elyam\crm-whatsapp\` (repo local)
- `/opt/crm-whatsapp/` (VPS, remote `crm-vps` via SSH)
- `apps/web/` — Next.js
- `apps/api/` — NestJS
- `packages/shared/` — tipos compartilhados
- `docs/` — PRD/architecture/stories

## Estado de produção (deploy em 2026-04-16)
- Backend rodando em `http://187.127.11.117:3001`
- Health `/api/health` → 200
- Branch `master`, HEAD `a358160`
- Docker Compose v2.38, image `crm-whatsapp-crm-backend:latest`
- Migrations Prisma aplicadas até `20260416150000_phase2_media_metadata`
- Env file: `/opt/crm-whatsapp/.env` (não versionado)

## Regras críticas (CLAUDE.md do projeto)
1. NUNCA processar webhooks sincronamente — SEMPRE BullMQ
2. NUNCA `any` no TypeScript
3. SEMPRE directUrl no Prisma para migrations
4. SEMPRE upsert por whatsapp_message_id (UNIQUE)
5. SEMPRE signed URLs do Supabase Storage
6. SEMPRE bcrypt salt 12 para senhas
7. SEMPRE validar input com Zod
8. SEMPRE emitir WebSocket após mutações Kanban/Chat
9. SEMPRE FFmpeg no Dockerfile do backend

---

## Fases já entregues

### Fase 1 — Áudio PTT correto (commit `a38aff1`)
- FFmpeg com flags WhatsApp: `-c:a libopus -b:a 24k -ar 16000 -ac 1 -application voip -vbr on -compression_level 10 -frame_duration 60 -f ogg`
- UazAPI payload: `{ number, type: 'ptt', file: <url|base64> }`
- Envs: `UAZAPI_PTT_FIELD=ptt` | `audio+ptt`, `AUDIO_SEND_STRATEGY=auto` | `url` | `base64`
- `media_duration_seconds` persistido via ffprobe
- Body limit 50mb em `main.ts`
- Arquivos: `apps/api/src/modules/media/audio.service.ts`, `messages.service.ts#sendAudio`, `main.ts`

### Fase 2 — Pipeline de mídia + fila outgoing (commit `97cdd09`)
- `MediaPipelineService` (`media-pipeline.service.ts`):
  - Detecção real de MIME via `file-type@22` (ESM, type shim em `apps/api/src/types/file-type.d.ts`)
  - Whitelist: image/jpeg|png|webp|gif, video/mp4|webm|quicktime, audio/ogg|mpeg|mp4|wav, application/pdf
  - Limites: img 10MB, video 50MB, audio 16MB, doc 20MB
  - Sharp: `failOn:'truncated'`, `limitInputPixels:24M` (proteção decompression bomb), `pipeline.clone()` para thumb (evita double-decode), EXIF strip automático via `.rotate()`
  - Vídeo: ffmpeg extrai poster frame em 1s + probe dimensions
  - Persiste `media_width`, `media_height`, `media_thumbnail_path`, `media_poster_path`, `media_size_bytes`, `media_waveform_peaks`
- Fila `messages-send` (`messages.queue.ts` + `messages.processor.ts`):
  - BullMQ, concurrency 5, attempts 5, backoff expo 10s
  - 3 tipos de job: text | audio | media
  - Re-assina URL antes de enviar (TTL 3600s)
  - `onFailed` persiste `status='FAILED'` + emit WS + invalidateCache após esgotar attempts
  - Strategy auto: tenta URL, fallback base64 em erro
- Migration `20260416150000_phase2_media_metadata` aplicada
- Módulos atualizados: `messages.module.ts` com `defaultJobOptions`; `media.module.ts` exporta `MediaPipelineService`

### Fase 3 — Backend hardening (commits `a5e2c03`, `6489b9b`, `e866e13`)

**Wave A** (`a5e2c03`) — observability + segurança básica:
- `AllExceptionFilter` (`common/filters/all-exception.filter.ts`): envelope estável `{error,message,code,statusCode,requestId,path,timestamp,details?}`, traduz ZodError/Prisma P2002|P2025|P2003, loga 5xx=error, 4xx=warn, esconde stack em prod
- `nestjs-pino` em `app.module.ts` com redact paths: `authorization, cookie, x-api-key, password, senha, token, newPassword, currentPassword, confirmPassword, secret, uazapi_token, *.password, *.senha, *.token, *.secret`
- `helmet` em `main.ts` com CSP e crossOriginResourcePolicy desabilitados (API pura)
- WebSocket CORS: env-driven allowlist (`FRONTEND_URL.split(',')`), não mais `origin:'*'`

**Wave B** (`6489b9b`) — RBAC + Bull Board:
- Hierarquia: SUPER_ADMIN(4) > GERENTE(3) > OPERADOR(2) > VISUALIZADOR(1) — `RolesGuard` checa se role.level >= required.level
- Anotações `@Roles()` aplicadas:
  - `instances.controller`: GERENTE em POST /, POST /:nome/reconnect, DELETE /:nome, GET /:nome/qr (side-effect)
  - `users.controller`: GERENTE em GET /; findAll escopado por tenant (fix de vazamento cross-tenant)
  - `pipelines.controller`: GERENTE em 12 rotas write
  - `messages.controller`: OPERADOR em send-text/audio/media + internal-note
- Bull Board em `/admin/queues`:
  - `admin.module.ts` com `BullBoardModule.forRoot` + forFeature (messages-send, webhooks)
  - `admin-auth.middleware.ts`: JWT via Bearer ou `?token=`, exige role SUPER_ADMIN
  - Wired em `app.module.ts`

**Wave C** (`e866e13`) — Sentry:
- `common/sentry.ts`: helper `initSentry()` no-op sem `SENTRY_DSN`, `isSentryEnabled()`, PII scrubbing
- `main.ts`: `initSentry()` antes do NestFactory.create
- `AllExceptionFilter`: `Sentry.captureException` apenas para status >= 500, com tags code/statusCode e context request
- Envs: `SENTRY_DSN, SENTRY_ENV, SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE, SENTRY_PROFILES_SAMPLE_RATE`
- Nota: plano pedia migração class-validator→Zod, mas o projeto já usa Zod (9 services), não tinha class-validator. Item considerado atendido.

---

## Infraestrutura de deploy

### Deploy no VPS
- Alias SSH: `crm-vps` → `root@187.127.11.117` (`~/.ssh/id_ed25519_crm`)
- Script: `scripts/deploy.sh` (usa rsync — não disponível em Git Bash Windows)
- **Fluxo alternativo usado** (git-pull-based):
  1. `git push origin master` localmente
  2. SSH na VPS: `cd /opt/crm-whatsapp && git stash push nginx/nginx.conf && git pull origin master`
  3. `cd apps/api && npm install --omit=dev`
  4. `npx prisma generate`
  5. `set -a && . /opt/crm-whatsapp/.env && set +a && npx prisma migrate deploy`
  6. `cd /opt/crm-whatsapp && docker compose build crm-backend`
  7. `docker compose up -d`
  8. curl `/api/health`

### docker-compose.yml (na raiz do repo)
- `crm-backend` (NestJS), `nginx` (alpine), `uptime-kuma`
- Passa envs: DATABASE_URL, DIRECT_URL, REDIS_URL, UAZAPI_*, SUPABASE_*, JWT_*, WEBHOOK_SECRET, FRONTEND_URL, FFMPEG_PATH, FFPROBE_PATH, TMP_VIDEO_DIR, LOG_LEVEL, UAZAPI_PTT_FIELD, AUDIO_SEND_STRATEGY, SENTRY_*
- Resource limits: 2G mem, 0.8 CPU

### Gotchas conhecidos
- **Dockerfile usa npm**, repo usa pnpm. `package-lock.json` desatualizado no VPS precisou ser removido para `npm install` funcionar com package.json novo
- **`file-type@22` é ESM-only** — tsc com `moduleResolution:node` legacy não lê `exports` field. Fix: shim em `apps/api/src/types/file-type.d.ts`. Alternativa seria migrar tsconfig para `moduleResolution:node16` mas quebraria outros imports CJS
- **Redis container** já usa `maxmemory-policy noeviction` (correto para BullMQ). Caso troque por managed Redis no futuro, conferir esta config — `volatile-lru` pode descartar jobs in-flight
- `.env` do repo raiz é compartilhado pelos dois apps; ConfigModule em `apps/api` lê `['.env','../../.env']`

---

## Phases pendentes (não commitadas)

### Fase 4 — Frontend polish
- Waveform real na gravação (AudioContext + AnalyserNode, 40 picos RMS); enviar `duration_seconds` + `waveform_peaks`
- `<AudioBubble>` com peaks persistidos em `Message.media_waveform_peaks`
- Lightbox de imagem via `yet-another-react-lightbox`
- `<video>` com poster + controls + overlay play
- Document bubble (ícone por tipo, nome, tamanho)
- Drag-drop + Ctrl+V paste no `ChatMain`
- Ticks de status (✓ / ✓✓ / ✓✓ azul)
- Arquivos: `apps/web/src/components/chat/chat-composer.tsx`, `message-*.tsx`, `chat-main.tsx`

### Fase 5 — Testes + observabilidade
- Jest unit (60% coverage em audio.service, media-pipeline, messages.service)
- Webhook e2e com fixture UazAPI real
- Playwright smoke (login→kanban→chat→enviar texto)
- GH Actions CI (install→typecheck→lint→test→build, Node 20)
- Healthcheck robusto (`GET /api/health` checa DB+Redis+UazAPI)
- `nestjs-prometheus` em `/metrics`: `messages_sent_total{type,status}`, `webhooks_received_total{provider}`, `queue_jobs_duration_seconds`

### Fase 6 — DB, perf, multi-tenant
- Supabase RLS: `USING (tenant_id = current_setting('app.tenant_id')::uuid)` por tabela
- Middleware Nest: `SET LOCAL app.tenant_id = ...` por request
- Índices:
  - `idx_message_lead_created ON Message(lead_id, created_at DESC)`
  - `idx_lead_tenant_stage ON Lead(tenant_id, stage_id, updated_at DESC)`
  - `idx_lead_phone_tenant ON Lead(tenant_id, phone)`
- Enum `MessageStatus` (PENDING|SENT|DELIVERED|READ|FAILED)
- Enum `Direction` (INBOUND|OUTBOUND)
- `deleted_at TIMESTAMPTZ` em Lead, Message, User + middleware Prisma de filtro global

---

## Débitos técnicos abertos (security review da Wave B)

| # | Severidade | Descrição |
|---|-----------|-----------|
| HIGH #2 | MED-pós-Phase2 | Multer upload sem validação direta no controller (mitigado por MediaPipeline, mas não defense-in-depth) |
| MED #3 | MED | `?token=` query no JWT middleware pode vazar em access logs — considerar redaction no Pino |
| MED #4 | MED | `GET /users/list` devolve usuários tenant-scoped sem role gate (talvez intencional, verificar) |
| LOW #6 | LOW | `JwtModule` declarado em `auth.module` e `admin.module` — considerar shared config |
| LOW #7 | LOW | `forRoutes('/admin/queues*')` — syntax wildcard |

---

## Envs importantes

```bash
# Core
DATABASE_URL, DIRECT_URL, REDIS_URL, JWT_SECRET,
JWT_REFRESH_SECRET, WEBHOOK_SECRET, FRONTEND_URL

# UazAPI
UAZAPI_BASE_URL, UAZAPI_ADMIN_TOKEN, WEBHOOK_PUBLIC_URL

# Supabase
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET

# Phase 1
UAZAPI_PTT_FIELD=ptt
AUDIO_SEND_STRATEGY=auto
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe

# Phase 2
TMP_VIDEO_DIR=/tmp/video

# Phase 3
LOG_LEVEL=info
SENTRY_DSN=              # vazio = Sentry off
SENTRY_ENV=production
SENTRY_TRACES_SAMPLE_RATE=0.0
```

---

## Arquivos críticos para qualquer sessão
- `apps/api/src/app.module.ts` — todos os módulos + Pino + APP_FILTER
- `apps/api/src/main.ts` — bootstrap, Sentry init, helmet, body limits, CORS
- `apps/api/src/modules/messages/messages.service.ts` — sendText/Audio/Media
- `apps/api/src/modules/messages/messages.processor.ts` — worker da fila
- `apps/api/src/modules/media/media-pipeline.service.ts` — pipeline unificado
- `apps/api/src/modules/media/audio.service.ts` — FFmpeg PTT
- `apps/api/src/modules/webhooks/webhook.processor.ts` — ingest webhooks
- `apps/api/src/modules/webhooks/message-extractor.ts` — parse payloads
- `apps/api/src/common/filters/all-exception.filter.ts` — envelope erros
- `apps/api/src/common/middleware/admin-auth.middleware.ts` — Bull Board guard
- `apps/api/src/common/guards/roles.guard.ts` — hierarquia de roles
- `apps/api/prisma/schema.prisma` — Message, Lead, Tenant, User
- `apps/web/src/components/chat/chat-composer.tsx` — MediaRecorder
- `docker-compose.yml` — orquestração VPS

---

## Workflow preferido do usuário
- Executar em fases incrementais com commits atômicos
- Cada commit com trailers: Constraint/Rejected/Confidence/Scope-risk/Directive/Not-tested
- Typecheck antes de commitar
- Usar subagentes (executor/verifier/code-reviewer/security-reviewer) para trabalhos grandes
- Português BR como idioma de comunicação
- Usuário autoriza push/deploy direto quando pede explicitamente
- Usuário não quer ser perguntado sobre cada pequena decisão; se o caminho é óbvio, seguir
