# Painel Admin — Cobrança manual, suspensão e exclusão rápida

**Data:** 2026-08-24
**Status:** aprovado em conversa (aguardando revisão final do spec)

## Problema

O painel admin não sabe quem pagou. Excluir cliente exige digitar o nome completo
num `window.prompt`, suspender só existe dentro do detalhe, e não há visão de
receita/inadimplência. O operador (Yuri) controla pagamento de cabeça e quer:
ver quem está vencido, suspender/reativar e excluir com poucos cliques.

Sem automação de suspensão/exclusão — verificação é manual, por decisão do
operador. Único automatismo: aviso de vencimento no CRM do cliente.

## Escopo

### Schema (model `Tenant`)

Campos novos, todos opcionais (tenant sem cobrança configurada continua válido):

| Campo | Tipo | Significado |
|---|---|---|
| `billing_value` | `Int?` | valor do contrato em **centavos** |
| `billing_cycle_months` | `Int?` | ciclo: 1=mensal, 3=trimestral, 6=semestral, 12=anual |
| `billing_paid_until` | `DateTime?` | pago até esta data — É a data de vencimento (fonte única) |
| `suspended_at` | `DateTime?` | suspensão explícita (hoje é inferida por "todos users inativos") |

Migration segue o runbook do CLAUDE.md (banco com `_prisma_migrations` poluído):
`prisma migrate diff` → SQL só-de-objetos-novos → aplicar em transação →
`prisma migrate resolve --applied`. Nunca `migrate deploy` nem `db push`.

### Status de cobrança (derivado, nunca persistido)

- `sem_cobranca` — `billing_value` ou `billing_paid_until` nulos
- `em_dia` — `paid_until` ≥ hoje e faltam >3 dias
- `vence_em_breve` — `paid_until` ≥ hoje, faltam ≤3 dias
- `vencido` — `paid_until` < hoje (expõe `dias_vencido`)

Derivação em função pura compartilhada no backend (`billing-status.ts`),
testada isolada (viradas de mês/ano, dia 31, ciclos 1/3/6/12).

### Backend (`platform-admin`)

1. `PATCH /platform-admin/tenants/:id/billing` — body Zod:
   `{ billing_value?, billing_cycle_months?, billing_paid_until? }`. Configura
   contrato; `billing_paid_until` editável direto (date picker) para acertos
   manuais.
2. `POST /platform-admin/tenants/:id/billing/mark-paid` — avança
   `billing_paid_until` em `billing_cycle_months` meses a partir de
   `max(paid_until, hoje)` (cliente atrasado que paga não ganha crédito
   retroativo perdido nem fica adiantado errado). Audit log `tenant_mark_paid`
   com valor e nova data.
3. `GET /platform-admin/billing-summary` — para os cards KPI:
   `{ receita_mensal_esperada, em_dia: {qtde, valor_mensal}, vencidos: {qtde, valor_mensal}, suspensos }`.
   Receita mensal normalizada = `billing_value / billing_cycle_months`.
4. `listTenants` passa a retornar os campos billing + status derivado +
   `suspended` (do campo novo).
5. Suspensão (`PATCH .../suspend`, já existe): além de desativar users, grava
   `suspended_at` (ou limpa ao reativar). **Webhook processor descarta eventos
   de tenant suspenso** no início do processamento (não gasta fila/banco com
   quem não paga). Envio de mensagens de tenant suspenso também é bloqueado.
6. Aviso automático de vencimento: `@Cron` diário (junto dos crons existentes)
   cria `Announcement` direcionado ao tenant: "Sua fatura vence em 3 dias" /
   "Fatura vencida — regularize". Dedupe: não recria se já existe anúncio ativo
   do mesmo tipo para o mesmo vencimento. Nunca suspende nada.
7. Tudo protegido por `PlatformAdminGuard` + `assertTenantAllowed` (tenant do
   master continua invisível/intocável para admin restrito) + audit log.

### Frontend — lista `/admin/tenants` (referência: painéis SaaS tipo Stripe/Asaas)

- **Cards KPI no topo:** receita mensal esperada · R$ em dia · R$ vencido
  (+qtde) · suspensos.
- **Aba nova "Vencidos"** ao lado de Conectados/Desconectados/Todos, com
  contagem.
- **Coluna "Pagamento":** badge colorida — verde `em dia`, âmbar `vence em Xd`,
  vermelho `vencido há Xd`, cinza `—` (sem cobrança). Tooltip com valor/ciclo.
- **Ações na linha** (sem abrir detalhe): Marcar pago · Suspender/Reativar ·
  Entrar como owner · Excluir.
- **Excluir = modal** (componente Dialog já usado no app) com resumo do que
  será apagado + botão vermelho único. Fim do `window.prompt` com nome.
  Suspender/reativar usa confirmação leve no mesmo modal padrão.
- Linha de tenant suspenso ganha visual atenuado + badge SUSPENSO.

### Frontend — detalhe `/admin/tenants/[id]`

- Seção **Cobrança**: valor, ciclo (select mensal/trimestral/semestral/anual),
  "pago até" (date picker), botão **Marcar pago**.
- Badge SUSPENSO passa a ler `suspended_at`.
- Excluir troca `window.prompt` pelo mesmo modal da lista.

## Fora de escopo

Gateway de pagamento (Asaas/Stripe), suspensão/exclusão automáticas, histórico
detalhado de pagamentos (audit log cobre), nota fiscal, multi-moeda.

## Testes

- `billing-status.spec`: derivação pura (limites de 3 dias, vencido, sem
  cobrança, dia 31 em fevereiro, ciclo 12 virando ano).
- `mark-paid`: avança pelo ciclo a partir de `max(paid_until, hoje)`; audit log.
- `webhook processor`: evento de tenant suspenso é descartado; não suspenso
  processa normal.
- `billing-summary`: normalização mensal (anual ÷ 12 etc.).
- Guards: admin restrito não enxerga/edita billing do tenant protegido.

## Riscos

- Migration em banco poluído — mitigado pelo runbook existente.
- Soma de meses caindo em dia inexistente (31/jan + 1 mês) — clamp para o
  último dia do mês (coberto por teste).
- Suspensão agora tem duas fontes (users inativos legado + `suspended_at`) —
  na migration, backfill: tenant com todos users inativos ganha
  `suspended_at = now()` para não haver estado misto.
