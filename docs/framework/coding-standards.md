# Coding Standards

## TypeScript
- NUNCA usar `any` -- usar `unknown` e fazer type narrowing
- SEMPRE types explicitos em retornos de funcoes publicas
- Prefer interfaces sobre types para objetos

## NestJS
- SEMPRE usar Zod para validacao de input (nao class-validator sozinho)
- SEMPRE transactions Prisma para multiplas tabelas
- NUNCA processar webhooks sincronamente

## React/Next.js
- SEMPRE usar TanStack Query para dados do servidor
- SEMPRE usar Zustand para estado de UI
- SEMPRE usar shadcn/ui como base de componentes
