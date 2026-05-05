# Tech Stack

## Backend (apps/api)
- NestJS 10 + TypeScript
- Prisma 5 -> Supabase PostgreSQL
- BullMQ -> Redis (container crm-redis em docker-compose; rediss:// suportado caso troque por managed)
- Socket.IO 4 (WebSocket)
- JWT (access 15min, refresh 7d httpOnly cookie)

## Frontend (apps/web)
- Next.js 14 App Router
- Tailwind CSS + shadcn/ui
- @dnd-kit (Kanban)
- Framer Motion (animacoes)
- TanStack Query + Zustand

## Infra
- VPS: 187.127.11.117 (Hostinger KVM2)
- Supabase: dzjjpuwqhphgcevjvvbh.supabase.co (sa-east-1)
- Redis: container crm-redis (in-cluster, sem URL externa)
