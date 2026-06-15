# CRM WhatsApp — Projeto

## Stack
- Frontend: Next.js 14 App Router + TypeScript → Vercel
- Backend: NestJS + Socket.IO → VPS Docker (187.127.11.117)
- DB: Supabase PostgreSQL + Storage
- ORM: Prisma (SEMPRE usar directUrl para migrations)
- Filas: BullMQ + Redis (container crm-redis)
- WhatsApp: UazAPI (Baileys-compatible payloads)
- IA: módulo `ai/` provider-agnóstico (Anthropic SDK + OpenAI-compatible); modelos platform-scoped (super admin), chaves cifradas AES-256-GCM (`AI_ENCRYPTION_KEY`)

## Regras CRITICAS
1. NUNCA processar webhooks sincronamente — SEMPRE BullMQ
2. NUNCA `any` no TypeScript
3. SEMPRE directUrl no Prisma para migrations
4. SEMPRE upsert por whatsapp_message_id (UNIQUE)
5. SEMPRE signed URLs do Supabase Storage
6. SEMPRE bcrypt salt 12 para senhas
7. SEMPRE validar input com Zod
8. SEMPRE emitir WebSocket apos mutacoes Kanban/Chat
9. SEMPRE FFmpeg no Dockerfile do backend

## Estrutura
- apps/web: Next.js frontend
- apps/api: NestJS backend
- packages/shared: tipos compartilhados
- docs/: PRD, architecture, stories aiox

## IA nativa (F1/F2/F3 — jun/2026)
- Backend `apps/api/src/modules/ai/`: adapters (`anthropic`, `openai_compatible`),
  `AiProviderService.chat()`, CRUD `/ai/models` + `/ai/agent` (PlatformAdminGuard),
  `/ai/copilot` + `/ai/suggest-reply` (atendente). Chaves cifradas, nunca retornadas.
- Follow-up `apps/api/src/modules/broadcasts/`: `BroadcastDispatcher` (@Cron) dispara
  1 msg/janela `throttle_seconds`; modo template ou IA-personalizado; sender_type='system'.
- Frontend: `/admin/ai`, `CopilotSheet` (chat-header), Sparkles no composer, `/followup`.
- Plano completo: `docs/AI-INTEGRATION-PLAN.md`.
- ⚠️ Anthropic adapter NÃO envia temperature (Opus 4.7/4.8/Fable → 400).
- Env novo: `AI_ENCRYPTION_KEY` (setar no VPS também).

## ⚠️ Migrations — estado real do banco (CRÍTICO)
Este Supabase (`dzjjpuwqhphgcevjvvbh`) já hospedou um Evolution API antes. O
`_prisma_migrations` está POLUÍDO: ~121 linhas, com migrations Evolution/Chatwoot
órfãs, duplicatas e ~47 "unfinished" (finished_at null). As tabelas reais são só
as do CRM (zero tabelas Evolution).
- NUNCA rodar `prisma migrate deploy` (falha P3009 pelas unfinished) nem
  `prisma db push` cego (há DRIFT pré-existente: FKs de Lead/InstanceHidden/
  PushSubscription e tipo de `Lead.assumed_at`).
- Para aplicar schema novo: gerar SQL só-de-objetos-novos via
  `prisma migrate diff --from-schema-datasource ... --to-schema-datamodel ... --script`,
  limpar o drift não-relacionado, aplicar a SQL atomicamente (transação) e
  registrar com `prisma migrate resolve --applied <nome>`.
- Helper read-only: `apps/api/scripts/introspect-db.mjs`.
- rtk hook quebra `npx prisma migrate ...` (PATH) — chamar via
  `node ../../node_modules/prisma/build/index.js ...`.
