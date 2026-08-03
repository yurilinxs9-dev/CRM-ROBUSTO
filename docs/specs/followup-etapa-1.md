# Follow-up — Etapa 1: parar de causar dano e enxergar o resultado

**Status:** implementado (schema, detecção da resposta, janela de horário, painel)
**Data:** 2026-08-03

## Problema

Dois comportamentos do disparo foram encontrados lendo o código, não reportados por usuário.
Ambos criam risco real de o número ser denunciado e bloqueado no WhatsApp.

### 1. Resposta do cliente não interrompe o disparo

`broadcast-sender.service.ts:79-86` pula um alvo em três casos: lead sem telefone, lead que
saiu da etapa alvo, e `respect_ai_block && lead.ai_blocked`.

`ai_blocked` só é ligado quando **alguém do time envia** uma mensagem
(`inbound-message.service.ts`, ramo `isFromMe`). Mensagem **do cliente** não liga nada.

Consequência: o cliente responde "já comprei, obrigada", ninguém da equipe vê a tempo, e o
disparo continua enviando a cada `throttle_seconds` até a lista acabar. O sistema entende
"humano assumiu" como sinal de parada, mas não entende "o cliente respondeu".

Nenhum arquivo fora de `modules/broadcasts/` referencia `BroadcastTarget` hoje — o webhook
não tem gancho nenhum com o disparo.

### 2. O disparo roda 24 horas por dia

`broadcast.dispatcher.ts:36` é `@Cron(CronExpression.EVERY_MINUTE)` sem nenhuma restrição de
horário. As únicas travas são `throttle_seconds` (padrão 15min) e `daily_limit` (padrão 30).

Um follow-up iniciado às 18h continua a madrugada inteira. Clientes recebem mensagem de
vendas às 3 da manhã.

### 3. Consequência das duas: não dá para medir

Sem saber quem respondeu, não existe a única métrica que diz se o disparo valeu a pena —
quantas conversas ele gerou. O painel hoje mostra enviados, pendentes, pulados e falhas.
O campo `error` é gravado em `BroadcastTarget` mas a tela só exibe a contagem, nunca o motivo.

## Decisões

| Questão | Decisão |
|---|---|
| Cliente responde | Sai da fila, marcado como respondeu, responsável notificado, aparece no painel |
| Janela de horário | Configurável por empresa |
| Fuso | `America/Sao_Paulo`, o mesmo que o reset do limite diário já assume |

## Mudanças

### 1. Schema

```prisma
enum BroadcastTargetStatus {
  pending
  sent
  failed
  skipped
  replied   // cliente respondeu depois de receber — conversa gerada
}

model BroadcastTarget {
  // ... campos atuais
  replied_at DateTime?

  @@index([broadcast_id, status])
  @@index([lead_id, status])   // NOVO — ver Riscos
}

model Tenant {
  // ... campos atuais
  broadcast_window_start Int   @default(9)               // hora local, 0-23
  broadcast_window_end   Int   @default(18)              // hora local, 0-23
  broadcast_window_days  Int[] @default([1, 2, 3, 4, 5]) // ISO: 1=segunda ... 7=domingo
}
```

### 2. Detecção da resposta — `inbound-message.service.ts`

No ramo de mensagem do cliente (`!isFromMe`), depois da mensagem persistida, resolver os
alvos daquele lead em disparos cujo `status` seja `running` ou `paused`:

- alvo em `sent` → vira `replied`, com `replied_at`
- alvo em `pending` → vira `skipped`, `error = "cliente já estava conversando"`

A distinção é deliberada. Se todo inbound virasse `replied`, um cliente que escreveu por
outro motivo contaria como sucesso do disparo e a métrica ficaria inútil.

Disparos em `done` e `canceled` não são tocados — seu histórico é imutável.

A notificação ao responsável reutiliza o caminho já existente de notificação de mensagem
nova; não é um canal novo.

### 3. Janela de horário — `broadcast.dispatcher.ts`

A decisão vira **função pura**, sem Prisma nem relógio implícito:

```ts
export function isWithinBroadcastWindow(
  now: Date,
  timeZone: string,
  startHour: number,
  endHour: number,
  activeDays: number[],
): boolean
```

O `tick()` resolve os tenants dos disparos ativos uma vez por execução e consulta essa
função antes de despachar. Fora da janela, o alvo permanece `pending` e a fila apenas
espera — nada vira falha, nada é perdido.

### 4. Painel — `apps/web/src/app/(dashboard)/followup/page.tsx`

No cartão de cada disparo:

- **Respostas** em destaque, ao lado de enviados
- **Falhas com o motivo**, lendo o `error` que já é gravado
- **Previsão de término**: pendentes × `throttle_seconds`, limitada por `daily_limit`

`target_counts` já vem de um `groupBy` por status, então a contagem de `replied` aparece
sem mudança no contrato da API.

O cartão é reescrito e sai usando as classes de token (`bg-surface-*`, `text-ink-*`,
`border-line-*`) em vez de `style={{}}` inline, e sem `confirm()` do navegador. O resto da
tela — em especial o formulário de criação — fica como está; é a Etapa 3.

## Testes

- `isWithinBroadcastWindow` como função pura: dentro da janela, fora, virada de dia, fim de
  semana, e disparo iniciado às 18h que só retoma às 9h do dia seguinte
- Detecção da resposta, com Prisma mockado: `sent` → `replied`; `pending` → `skipped`;
  disparo `done` intocado; lead sem alvo nenhum não gera escrita
- Dispatcher não despacha fora da janela e não marca o alvo como falha

## Riscos

1. **O gancho roda em toda mensagem recebida.** Foram 780 em três horas hoje. `BroadcastTarget`
   não tem índice por `lead_id` — sem o índice novo, cada mensagem faria varredura de tabela
   inteira. O índice não é otimização, é pré-requisito.
2. **Migration em produção.** O banco tem `_prisma_migrations` poluído; DDL vai por script
   `.cjs` idempotente, como em `migrate-conversation-a.cjs`. Adicionar valor a enum e coluna
   nullable é aditivo e reversível.
3. **Mudança de comportamento visível.** Disparos existentes passam a parar quando o cliente
   responde e a respeitar horário. É o pedido, mas precisa ser avisado à equipe antes do deploy.

## Fora de escopo

- Segmentação por temperatura e tags (Etapa 2) — o campo `segment` existe e segue sem uso
- Acabamento visual do resto da tela, incluindo o formulário de criação (Etapa 3)
- Fuso configurável por empresa: fica em `America/Sao_Paulo`, como o resto do sistema
