# CRM WhatsApp — Projeto

## Stack
- Frontend: Next.js 14 App Router + TypeScript → Vercel
- Backend: NestJS + Socket.IO → VPS Docker (187.127.11.117)
- DB: Supabase PostgreSQL + Storage
- ORM: Prisma (SEMPRE usar directUrl para migrations)
- Filas: BullMQ + Upstash Redis TLS
- WhatsApp: Evolution API v2

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
