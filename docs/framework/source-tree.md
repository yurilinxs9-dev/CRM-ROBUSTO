# Source Tree

## apps/api/src/
- main.ts -- bootstrap NestJS
- app.module.ts -- root module
- common/ -- guards, decorators, pipes, prisma
- modules/auth -- JWT auth
- modules/leads -- CRUD leads
- modules/messages -- envio/recebimento WhatsApp
- modules/media -- Supabase Storage
- modules/instances -- gestao Evolution API
- modules/webhooks -- BullMQ processors
- modules/websocket -- Socket.IO gateway
- modules/pipelines -- funis e estagios
- modules/dashboard -- metricas
- modules/users -- gestao de usuarios

## apps/web/src/
- app/(auth)/login -- tela de login
- app/(dashboard)/kanban -- funil Kanban
- app/(dashboard)/chat -- chat WhatsApp
- app/(dashboard)/instances -- instancias
- app/(dashboard)/dashboard -- metricas
- components/ -- UI components
- hooks/ -- custom hooks
- stores/ -- Zustand stores
- lib/ -- utilities
