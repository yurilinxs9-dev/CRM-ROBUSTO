# Conversa por instância — fim do espelhamento entre vendedores

**Status:** aprovado, não implementado
**Data:** 2026-08-03
**Supersede:** `docs/specs/lead-scope-por-numero.md`

## Problema

Relato de campo (Cajuru Interiores, modo Individual):

> "As conversas que são espelhadas são contatos que às vezes eu já conversei há um
> tempo atrás, e outro vendedor está conversando atualmente. Essa mulher, eu
> conversei com ela há um tempo atrás, e agora ela entrou em contato com o Alex."

A vendedora vê a conversa que o Alex está tendo com a cliente.

O contraste que ela mesma dá — *"quando a conversa que só um vendedor já conversou,
ela não espelha"* — confirma o recorte: **só quebra quando dois vendedores entram no
mesmo contato**. É um bug, não dois.

### Causa raiz

`inbound-message.service.ts:356` fixa o escopo de identidade do lead no tenant:

```ts
const leadScope = tenantId;
```

Com isso o upsert de `:358` casa por `(telefone, pipeline_id, tenant_id)` e reencontra
o lead criado pelo primeiro vendedor. O bloco `update` de `:386-394` **não toca** em
`responsavel_id` nem `instancia_whatsapp` — por design, para não reverter claim humana.
A mensagem então é gravada em `:576` com `visible_to_user_id: lead.responsavel_id`, ou
seja, o vendedor antigo.

Do outro lado, o vendedor que de fato recebeu a mensagem não a vê:

- `lead-visibility.ts:46-52` — modo Individual com `scope='chat'` força
  `responsavel_id = user.id`; o lead é do vendedor antigo, então não aparece na lista.
- `leads.service.ts:1131-1140` — se abrir o lead direto, não é responsável e
  `lead.instancia_whatsapp` não está entre as instâncias dele, então retorna
  `{ messages: [] }`.

### Histórico: é uma regressão

| Data | Commit | Efeito |
|---|---|---|
| 24/06 | `9cca2c5` | Cria `lead_scope`. Individual = `owner_user_id` da instância. Corrige o espelhamento (cita "Cajuru: 68 leads operador-operador") |
| 01/07 | `b898c70` | Reverte para `leadScope = tenantId` sempre, porque o escopo por dono duplicava o mesmo contato no Kanban quando ele fala com vários números |
| 10/07 | `26a81a1` | Refactor move a lógica para `inbound-message.service.ts`, carregando o `tenantId` |

O bug voltou em 01/07.

### Por que não é caso de mais um patch

Os dois requisitos são incompatíveis enquanto **Lead = contato = conversa** forem a
mesma linha:

- escopo por dono → não espelha, mas duplica o contato no Kanban;
- escopo por tenant → não duplica, mas espelha entre vendedores.

O eixo já oscilou duas vezes. Um terceiro ajuste no mesmo lugar reabre o outro sintoma.
A correção é separar as duas entidades.

## Solução

Separar **contato** de **conversa**:

- **Lead** — a pessoa. Continua único por `(telefone, pipeline_id, tenant_id)`.
  Um card no Kanban, sem duplicação.
- **Conversation** — o fio de mensagens entre um lead e **um número da empresa**.
  Único por `(lead_id, instancia_whatsapp)`, permanente: mensagem nova por aquele
  número sempre cai na mesma conversa, nunca cria duplicata.

`Lead.responsavel_id` e `Lead.instancia_whatsapp` **permanecem**, mas passam a ser
derivados — espelham a conversa ativa. Essa é a decisão que segura o custo: tudo que
hoje lê `Lead.responsavel_id` (Kanban, rodízio, relatórios, follow-up, visibilidade)
continua funcionando sem refactor.

**Conversa ativa** = a de maior `last_customer_message_at`.

### Regra de troca de dono

O dono do card muda quando **o cliente** manda mensagem por outro número.
Mensagem enviada pelo vendedor — manual, follow-up ou IA — não move o card.

Sem essa restrição, um disparo de follow-up pela instância do vendedor antigo geraria
mensagem na conversa dele, tornaria essa conversa a mais recente e traria o card de
volta sem intervenção do cliente. Automação não deve remanejar carteira.

### Consequência aceita

Quando o contato migra para outro vendedor, o card sai do Kanban do vendedor anterior.
Ele mantém a conversa antiga no histórico, mas perde o card. É o efeito direto de "o
card fica com quem está atendendo agora", escolhido conscientemente.

## Mudanças

### 1. Schema

```prisma
model Conversation {
  id                       String             @id @default(uuid())
  lead_id                  String
  lead                     Lead               @relation(fields: [lead_id], references: [id], onDelete: Cascade)
  instancia_whatsapp       String
  responsavel_id           String?
  responsavel              User?              @relation(fields: [responsavel_id], references: [id])
  status                   ConversationStatus @default(OPEN)
  last_customer_message_at DateTime?
  last_message_at          DateTime?
  assumed_at               DateTime?
  ai_blocked               Boolean            @default(false)
  tenant_id                String
  tenant                   Tenant             @relation(fields: [tenant_id], references: [id])
  created_at               DateTime           @default(now())
  updated_at               DateTime           @updatedAt

  messages                 Message[]

  @@unique([lead_id, instancia_whatsapp])
  @@index([tenant_id, responsavel_id])
  @@index([lead_id, last_customer_message_at])
}
```

`Message` ganha `conversation_id` (nullable durante o backfill, `NOT NULL` depois).
`Message.lead_id` **permanece** — desnormalizado de propósito, para não quebrar as
queries de histórico por lead que já existem.

`status`, `assumed_at` e `ai_blocked` passam a ser **escritos** na `Conversation` — são
estado de atendimento, não de contato. Os campos equivalentes no `Lead`
(`atendimento_status`, `assumed_at`, `ai_blocked`) não são removidos: continuam sendo
mantidos como espelho da conversa ativa, para não quebrar os consumidores atuais
(API pública, `BroadcastDispatcher`, guard da IA). Remoção fica para depois, quando
todos os leitores tiverem migrado.

Corrigir também o comentário obsoleto de `schema.prisma:296-303`, que ainda descreve
`lead_scope = owner_user_id` no modo Individual — comportamento removido em 01/07.

### 2. Webhook — `inbound-message.service.ts`, `saveIncomingMessage`

1. Upsert do Lead — **inalterado** (`:358`), segue `lead_scope = tenantId`.
2. **Novo:** upsert da Conversation por `(lead.id, instance.nome)`. No `create`,
   `responsavel_id` sai da regra atual (`inPool` / `soloDistribute` / `owner_user_id`
   da instância, `:333-344`). No `update`, não mexe em `responsavel_id`.
3. Auto-assign (`:404-411`) e round-robin (`:417-444`) passam a agir sobre a
   **Conversation**, não sobre o Lead.
4. Mensagem grava `conversation_id`, e `visible_to_user_id = conversation.responsavel_id`
   em vez de `lead.responsavel_id` (`:576`).
5. Se `!isFromMe`: atualiza `conversation.last_customer_message_at` e sincroniza
   `Lead.responsavel_id` / `Lead.instancia_whatsapp` a partir da conversa ativa.
6. O trava-IA de `:583-587` (`isFromMe` → `ai_blocked = true`) passa a escrever na
   `Conversation`, espelhando no `Lead` em seguida. Sem isso, o humano respondendo pelo
   celular no número do Alex travaria a IA na conversa da vendedora também.

O passo 5 é o que corrige o bug.

### 3. Leitura no chat — `leads.service.ts`

O filtro de mensagens de `:1156-1175` deixa de combinar `instance_name` +
`visible_to_user_id` e passa a filtrar por conversa: quem não é gerente vê apenas as
conversas onde é `responsavel_id`; gerente vê todas.

`filterByInstance` (`:1155`) e `visible_to_user_id` ficam no lugar até o backfill
concluir. Removê-los é limpeza posterior, fora do escopo deste fix.

### 4. Envio — `messages.service.ts`

`:208` resolve a instância de envio por `lead.instancia_whatsapp`. Passa a resolver
pela `Conversation` do atendente naquele lead. Corrige de passagem um efeito colateral
atual: responder um lead pode sair pelo número errado.

### 5. Superfície de API e frontend

**O frontend não muda neste fix.** A UI continua centrada em lead: abre-se um lead e
vê-se uma lista de mensagens. Quem resolve qual conversa exibir é o backend.

- **Não-gerente:** enxerga exatamente uma conversa por lead — aquela onde é
  `responsavel_id`. A resposta da API é idêntica em formato à de hoje.
- **Gerente / super admin:** hoje vê o histórico completo do lead. Continua vendo, com
  as mensagens de todas as conversas intercaladas por `created_at`, como já acontece.

Ou seja, nenhum endpoint muda de contrato e nenhuma tela precisa de seletor de conversa.
Um seletor explícito ("conversa pelo número X / pelo número Y") é melhoria de UX
posterior, avaliada junto com a reformulação da área de conversas — fora deste escopo.

## Migration

O `_prisma_migrations` deste Supabase (`dzjjpuwqhphgcevjvvbh`) está poluído — ~121
linhas, ~47 *unfinished* de um Evolution API anterior, mais drift pré-existente.
`migrate deploy` e `db push` cego são proibidos (ver `CLAUDE.md`).

### Fase A — DDL

1. Gerar SQL com
   `prisma migrate diff --from-schema-datasource ... --to-schema-datamodel ... --script`
2. Remover do script o drift não relacionado (FKs de `Lead`/`InstanceHidden`/
   `PushSubscription`, tipo de `Lead.assumed_at`)
3. Aplicar em transação única
4. Registrar com `prisma migrate resolve --applied <nome>`

`Message.conversation_id` entra nullable nesta fase.

### Fase B — Backfill

Idempotente e em lotes; o histórico do Cajuru é grande.

1. Uma `Conversation` por `(lead_id, Message.instance_name)` distinto
2. Lead sem mensagem: conversa a partir de `lead.instancia_whatsapp`
3. `responsavel_id` de cada conversa: a que casa com `lead.instancia_whatsapp` herda
   `lead.responsavel_id`; as demais herdam o `owner_user_id` da instância
4. `UPDATE Message SET conversation_id` em lotes
5. `last_customer_message_at` a partir do `MAX(created_at)` das mensagens `INCOMING`

Dry-run obrigatório, revisado, rodado primeiro só no tenant Cajuru.

### Fase C — Aperto

`Message.conversation_id` vira `NOT NULL` depois que a Fase B fecha sem órfãos.

## Testes

- `resolveActiveConversation()` como função pura, testada isolada, no mesmo estilo de
  `lead-visibility.spec.ts`
- **Regressão do bug:** contato fala com A, depois com B → mensagem na conversa de B,
  card vai para B, conversa de A não recebe nada
- **Caso que já funciona:** só um vendedor no contato → comportamento idêntico ao atual
- **Anti-roubo:** follow-up outbound pela instância de A não move o card
- **Idempotência do backfill:** rodar duas vezes não duplica conversas

## Riscos

1. **Backfill em produção.** Mitigação: lotes, idempotência, dry-run, Cajuru primeiro.
2. **Corrida no campo derivado.** Duas mensagens do cliente chegando juntas por
   instâncias diferentes podem embaralhar `Lead.responsavel_id`. Mitigação:
   `updateMany` condicional em `last_customer_message_at`, mesma técnica já usada no
   round-robin (`inbound-message.service.ts:424`).
3. **Card desaparece do Kanban do vendedor anterior.** Comportamento esperado, mas
   precisa ser comunicado à equipe antes do deploy.

## Ordem de deploy

Fase A (DDL) e código sobem juntos — o upsert novo depende da unique nova existir.
Fase B roda depois, com o sistema já gravando `conversation_id` nas mensagens novas.
Fase C fecha quando o backfill não deixar órfãos.
