# Conversa por instância — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`) para rastreamento.

**Goal:** Separar `Conversation` de `Lead` para que uma mensagem nova caia sempre na conversa do número por onde chegou, acabando com o espelhamento entre vendedores.

**Architecture:** `Lead` continua único por `(telefone, pipeline_id, lead_scope=tenant_id)` — um card no Kanban. Nasce `Conversation`, única por `(lead_id, instancia_whatsapp)`, dona de `responsavel_id`, `status`, `assumed_at` e `ai_blocked`. `Lead.responsavel_id` e `Lead.instancia_whatsapp` viram espelhos da conversa ativa (a de maior `last_customer_message_at`), então todo consumidor atual segue funcionando sem refactor.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL (Supabase), BullMQ, Jest 30 + ts-jest.

**Spec:** `docs/specs/conversa-por-instancia.md`

## Global Constraints

- **Nunca** rodar `prisma migrate deploy` nem `prisma db push` neste banco. O `_prisma_migrations` do Supabase `dzjjpuwqhphgcevjvvbh` tem ~121 linhas e ~47 *unfinished* de um Evolution API anterior; `migrate deploy` falha com P3009. Toda DDL vai por script `.cjs` idempotente, no padrão de `apps/api/scripts/migrate-lead-scope-1a.cjs`.
- O hook `rtk` quebra o PATH do `npx prisma`. Chamar sempre via `node ../../node_modules/prisma/build/index.js <comando>`.
- Proibido `any` no TypeScript (regra 2 do `CLAUDE.md`).
- Toda validação de input via Zod (regra 7).
- Emitir WebSocket após mutação de Kanban/Chat (regra 8).
- Testes rodam com `cd apps/api && npx jest`. `rootDir` é `src`, `testRegex` é `.*\.spec\.ts$`. **Não existe banco de teste** — os 5 specs do repo são todos de função pura. Lógica de decisão vai em função pura testável; wiring de Prisma é verificado por script de smoke.
- Branch de trabalho: `fix/conversa-por-instancia` (já criada, spec commitado em `db500ec`).
- Scripts de migration leem `DIRECT_URL` de `apps/api/.env`, nunca `DATABASE_URL` do pooler.

---

### Task 1: Função pura de roteamento de conversa

Isola a única regra de negócio nova — qual conversa é a ativa — numa função sem Prisma, testável de verdade. Todo o resto do plano depende dessa decisão estar correta.

**Files:**
- Create: `apps/api/src/modules/webhooks/conversation-routing.ts`
- Test: `apps/api/src/modules/webhooks/conversation-routing.spec.ts`

**Interfaces:**
- Consumes: nada (primeira tarefa)
- Produces:
  - `interface ConversationSnapshot { id: string; instancia_whatsapp: string; responsavel_id: string | null; last_customer_message_at: Date | null }`
  - `interface LeadSyncPatch { responsavel_id: string | null; instancia_whatsapp: string }`
  - `resolveActiveConversation(conversations: ConversationSnapshot[]): ConversationSnapshot | null`
  - `buildLeadSyncPatch(conversations: ConversationSnapshot[]): LeadSyncPatch | null`

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/api/src/modules/webhooks/conversation-routing.spec.ts`:

```ts
import {
  resolveActiveConversation,
  buildLeadSyncPatch,
  type ConversationSnapshot,
} from './conversation-routing';

const conv = (
  id: string,
  instancia: string,
  responsavel: string | null,
  lastCustomer: string | null,
): ConversationSnapshot => ({
  id,
  instancia_whatsapp: instancia,
  responsavel_id: responsavel,
  last_customer_message_at: lastCustomer ? new Date(lastCustomer) : null,
});

describe('resolveActiveConversation', () => {
  it('lista vazia devolve null', () => {
    expect(resolveActiveConversation([])).toBeNull();
  });

  it('conversa única é a ativa mesmo sem mensagem do cliente', () => {
    const a = conv('c1', 'inst-vendedora', 'u-vendedora', null);
    expect(resolveActiveConversation([a])?.id).toBe('c1');
  });

  it('BUG CAJURU: cliente falou por último com o Alex, então a conversa dele é a ativa', () => {
    const vendedora = conv('c1', 'inst-vendedora', 'u-vendedora', '2026-03-10T12:00:00Z');
    const alex = conv('c2', 'inst-alex', 'u-alex', '2026-08-03T09:00:00Z');
    expect(resolveActiveConversation([vendedora, alex])?.id).toBe('c2');
  });

  it('ordem da lista não altera o resultado', () => {
    const vendedora = conv('c1', 'inst-vendedora', 'u-vendedora', '2026-03-10T12:00:00Z');
    const alex = conv('c2', 'inst-alex', 'u-alex', '2026-08-03T09:00:00Z');
    expect(resolveActiveConversation([alex, vendedora])?.id).toBe('c2');
  });

  it('conversa sem mensagem do cliente perde para qualquer uma que tenha', () => {
    const semCliente = conv('c1', 'inst-a', 'u-a', null);
    const comCliente = conv('c2', 'inst-b', 'u-b', '2026-01-01T00:00:00Z');
    expect(resolveActiveConversation([semCliente, comCliente])?.id).toBe('c2');
  });

  it('empate exato desempata por id, de forma determinística', () => {
    const a = conv('c2', 'inst-a', 'u-a', '2026-08-03T09:00:00Z');
    const b = conv('c1', 'inst-b', 'u-b', '2026-08-03T09:00:00Z');
    expect(resolveActiveConversation([a, b])?.id).toBe('c1');
    expect(resolveActiveConversation([b, a])?.id).toBe('c1');
  });

  it('todas sem mensagem do cliente: desempata por id', () => {
    const a = conv('c2', 'inst-a', 'u-a', null);
    const b = conv('c1', 'inst-b', 'u-b', null);
    expect(resolveActiveConversation([a, b])?.id).toBe('c1');
  });
});

describe('buildLeadSyncPatch', () => {
  it('devolve o dono e a instância da conversa ativa', () => {
    const vendedora = conv('c1', 'inst-vendedora', 'u-vendedora', '2026-03-10T12:00:00Z');
    const alex = conv('c2', 'inst-alex', 'u-alex', '2026-08-03T09:00:00Z');
    expect(buildLeadSyncPatch([vendedora, alex])).toEqual({
      responsavel_id: 'u-alex',
      instancia_whatsapp: 'inst-alex',
    });
  });

  it('conversa ativa sem dono propaga null (lead volta pro pool)', () => {
    const a = conv('c1', 'inst-a', null, '2026-08-03T09:00:00Z');
    expect(buildLeadSyncPatch([a])).toEqual({
      responsavel_id: null,
      instancia_whatsapp: 'inst-a',
    });
  });

  it('sem conversa nenhuma devolve null — chamador não deve tocar no lead', () => {
    expect(buildLeadSyncPatch([])).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
cd apps/api && npx jest conversation-routing -v
```

Esperado: FAIL com `Cannot find module './conversation-routing'`.

- [ ] **Step 3: Implementar o mínimo**

Criar `apps/api/src/modules/webhooks/conversation-routing.ts`:

```ts
/**
 * Roteamento de conversa — funções PURAS, sem Prisma/IO, para serem testáveis
 * em isolamento (mesmo padrão de `leads/lead-visibility.ts`).
 *
 * A conversa ATIVA de um lead é a que recebeu a última mensagem DO CLIENTE.
 * Mensagem enviada pelo vendedor — manual, follow-up ou IA — não muda quem é a
 * ativa: senão um disparo automático pela instância antiga puxaria o card de
 * volta sem o cliente ter procurado ninguém.
 */

export interface ConversationSnapshot {
  id: string;
  instancia_whatsapp: string;
  responsavel_id: string | null;
  last_customer_message_at: Date | null;
}

export interface LeadSyncPatch {
  responsavel_id: string | null;
  instancia_whatsapp: string;
}

/**
 * Conversa ativa = maior `last_customer_message_at`. Conversas sem mensagem do
 * cliente ficam por último. Empate desempata por `id` (ordem estável, para o
 * resultado não depender da ordem em que o Prisma devolveu as linhas).
 */
export function resolveActiveConversation(
  conversations: ConversationSnapshot[],
): ConversationSnapshot | null {
  if (conversations.length === 0) return null;

  return conversations.reduce((best, current) => {
    const bestAt = best.last_customer_message_at?.getTime() ?? null;
    const currentAt = current.last_customer_message_at?.getTime() ?? null;

    if (bestAt === currentAt) return current.id < best.id ? current : best;
    if (bestAt === null) return current;
    if (currentAt === null) return best;
    return currentAt > bestAt ? current : best;
  });
}

/**
 * Campos derivados que o Lead deve espelhar da conversa ativa. `null` quando o
 * lead não tem conversa nenhuma — nesse caso o chamador NÃO deve tocar no lead.
 */
export function buildLeadSyncPatch(
  conversations: ConversationSnapshot[],
): LeadSyncPatch | null {
  const active = resolveActiveConversation(conversations);
  if (!active) return null;
  return {
    responsavel_id: active.responsavel_id,
    instancia_whatsapp: active.instancia_whatsapp,
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
cd apps/api && npx jest conversation-routing -v
```

Esperado: PASS, 10 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/webhooks/conversation-routing.ts apps/api/src/modules/webhooks/conversation-routing.spec.ts
git commit -m "feat(conversations): função pura de roteamento — conversa ativa é a do último cliente"
```

---

### Task 2: Schema Prisma + DDL da Fase A

Cria a tabela e a coluna. `Message.conversation_id` entra **nullable** — o backfill só roda na Task 7, e até lá o código antigo precisa continuar gravando mensagem sem conversa.

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model `Lead` ~266-344, model `Message` ~346-405, model `User` ~122, model `Tenant` ~76)
- Create: `apps/api/scripts/migrate-conversation-a.cjs`

**Interfaces:**
- Consumes: nada
- Produces: model Prisma `Conversation` com os campos `id`, `lead_id`, `instancia_whatsapp`, `responsavel_id`, `status`, `last_customer_message_at`, `last_message_at`, `assumed_at`, `ai_blocked`, `tenant_id`, `created_at`, `updated_at`; e `Message.conversation_id: String?`. Tasks 3–8 dependem desses nomes exatos.

- [ ] **Step 1: Adicionar o model `Conversation` ao schema**

Em `apps/api/prisma/schema.prisma`, logo após o model `Lead` (depois da linha 344):

```prisma
/// Fio de mensagens entre um Lead e UM número da empresa. Um contato que fala
/// com dois vendedores tem duas Conversations e continua com UM card no Kanban.
/// Dona do estado de atendimento (responsavel_id, status, assumed_at,
/// ai_blocked); o Lead espelha os da conversa ativa.
model Conversation {
  id                       String             @id @default(uuid())
  lead_id                  String
  lead                     Lead               @relation(fields: [lead_id], references: [id], onDelete: Cascade)
  instancia_whatsapp       String
  responsavel_id           String?
  responsavel              User?              @relation("ConversationResponsavel", fields: [responsavel_id], references: [id])
  status                   ConversationStatus @default(OPEN)
  /// Última mensagem DO CLIENTE. É este campo que elege a conversa ativa.
  last_customer_message_at DateTime?
  last_message_at          DateTime?
  assumed_at               DateTime?
  ai_blocked               Boolean            @default(false)
  tenant_id                String
  tenant                   Tenant             @relation(fields: [tenant_id], references: [id])
  created_at               DateTime           @default(now())
  updated_at               DateTime           @updatedAt

  messages Message[]

  @@unique([lead_id, instancia_whatsapp], name: "lead_instancia")
  @@index([tenant_id, responsavel_id])
  @@index([lead_id, last_customer_message_at])
}
```

- [ ] **Step 2: Adicionar as relações inversas**

No model `Lead`, junto das outras relações (perto da linha 317 `messages Message[]`):

```prisma
  conversations Conversation[]
```

No model `Message`, junto de `lead_id`/`lead` (perto da linha 348):

```prisma
  conversation_id        String?
  conversation           Conversation?    @relation(fields: [conversation_id], references: [id])
```

E o índice, junto dos outros `@@index` do `Message`:

```prisma
  @@index([conversation_id, created_at])
```

No model `User`:

```prisma
  conversations Conversation[] @relation("ConversationResponsavel")
```

No model `Tenant`:

```prisma
  conversations Conversation[]
```

- [ ] **Step 3: Corrigir o comentário obsoleto do `lead_scope`**

Em `apps/api/prisma/schema.prisma`, o bloco de comentário nas linhas 296-303 ainda descreve `lead_scope = owner_user_id` no modo Individual — comportamento removido em `b898c70` (01/07). Substituir por:

```prisma
  // Escopo de identidade do lead. SEMPRE tenant_id, nos dois modos → 1 lead por
  // telefone+pipeline no tenant, um card por contato no Kanban.
  // O isolamento entre vendedores NÃO vem daqui: vem de Conversation, que é
  // única por (lead_id, instancia_whatsapp). Ver docs/specs/conversa-por-instancia.md.
  // Histórico: o escopo por owner_user_id existiu entre 9cca2c5 (24/06) e
  // b898c70 (01/07) e foi revertido por duplicar o contato no Kanban.
  lead_scope          String
```

- [ ] **Step 4: Validar o schema e gerar o client**

```bash
cd apps/api && node ../../node_modules/prisma/build/index.js validate && node ../../node_modules/prisma/build/index.js generate
```

Esperado: `The schema at prisma/schema.prisma is valid` seguido de `Generated Prisma Client`.

- [ ] **Step 5: Escrever o script de DDL**

Criar `apps/api/scripts/migrate-conversation-a.cjs`:

```js
// FASE A (aditivo, reversível): cria a tabela Conversation e a coluna
// Message.conversation_id (NULLABLE). Não faz backfill — isso é a Fase B.
// Idempotente: pode rodar mais de uma vez sem estragar nada.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const url =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

(async () => {
  // 0. precondição: o enum ConversationStatus já existe (usado por Lead.atendimento_status)
  const enumRows = await q(
    `SELECT 1 FROM pg_type WHERE typname = 'ConversationStatus'`,
  );
  if (enumRows.length === 0) {
    console.error('ABORT: enum ConversationStatus não existe no banco.');
    process.exit(1);
  }
  console.log('precheck OK: enum ConversationStatus presente');

  // 1. tabela Conversation
  await x(`CREATE TABLE IF NOT EXISTS "Conversation" (
    "id" text PRIMARY KEY,
    "lead_id" text NOT NULL,
    "instancia_whatsapp" text NOT NULL,
    "responsavel_id" text,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "last_customer_message_at" timestamp(3),
    "last_message_at" timestamp(3),
    "assumed_at" timestamp(3),
    "ai_blocked" boolean NOT NULL DEFAULT false,
    "tenant_id" text NOT NULL,
    "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp(3) NOT NULL
  )`);
  console.log('tabela Conversation criada/já existia');

  // 1b. repara updated_at numa tabela já criada por uma versão anterior
  //     deste script: o schema declara `updated_at DateTime @updatedAt`,
  //     que o Prisma gerencia na aplicação e NÃO espera default no banco
  //     (diferente de created_at, cujo `@default(now())` é, sim, um default
  //     de banco legítimo — esse fica). CREATE TABLE IF NOT EXISTS não
  //     corrige uma tabela que já existe; por isso o DROP DEFAULT explícito,
  //     em coluna já existente, idempotente (sem default → no-op).
  await x(`ALTER TABLE "Conversation" ALTER COLUMN "updated_at" DROP DEFAULT`);
  console.log('Conversation.updated_at sem default (alinhado ao @updatedAt do Prisma)');

  // 2. índices
  await x(`CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_lead_id_instancia_whatsapp_key"
    ON "Conversation"("lead_id", "instancia_whatsapp")`);
  await x(`CREATE INDEX IF NOT EXISTS "Conversation_tenant_id_responsavel_id_idx"
    ON "Conversation"("tenant_id", "responsavel_id")`);
  await x(`CREATE INDEX IF NOT EXISTS "Conversation_lead_id_last_customer_message_at_idx"
    ON "Conversation"("lead_id", "last_customer_message_at")`);
  console.log('índices de Conversation OK');

  // 3. FKs, com as mesmas ações ON DELETE/ON UPDATE que o Prisma infere do
  //    schema (Conversation.lead_id obrigatório+cascade explícito;
  //    responsavel_id opcional → SET NULL; tenant_id obrigatório → RESTRICT;
  //    todas ON UPDATE CASCADE, que é o default do Prisma).
  //    Repara (drop+recria) em vez de "cria se não existir": rodar isto de
  //    novo numa base onde a constraint já existe com as ações certas é
  //    inócuo (drop+recreate idêntico); numa base com ações erradas, corrige.
  //    APENAS estas 4 constraints (as 4 criadas por este script) — nenhuma
  //    outra tabela/constraint é tocada.
  //    ADD CONSTRAINT ... NOT VALID + VALIDATE CONSTRAINT em vez de um único
  //    ADD CONSTRAINT: o primeiro só toma um lock breve (ACCESS EXCLUSIVE
  //    curto, sem varrer a tabela); o segundo varre para validar mas sob um
  //    lock mais fraco (SHARE UPDATE EXCLUSIVE) que NÃO bloqueia escrita.
  //    `Message` tem 245k linhas e é escrita o tempo todo — depois do
  //    backfill da Task 7 essa validação deixa de ser instantânea, e um
  //    ADD CONSTRAINT normal ali travaria escrita em Message pela duração
  //    do scan. Hoje a Conversation está vazia então não faz diferença
  //    prática nas 3 primeiras, mas a mesma forma em todas evita reintroduzir
  //    o problema se este script for copiado/adaptado depois.
  const fks = [
    {
      name: 'Conversation_lead_id_fkey',
      sql: `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_lead_id_fkey"
       FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`,
    },
    {
      name: 'Conversation_responsavel_id_fkey',
      sql: `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_responsavel_id_fkey"
       FOREIGN KEY ("responsavel_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID`,
    },
    {
      name: 'Conversation_tenant_id_fkey',
      sql: `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenant_id_fkey"
       FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID`,
    },
  ];
  for (const fk of fks) {
    await x(`ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "${fk.name}"`);
    await x(fk.sql);
    await x(`ALTER TABLE "Conversation" VALIDATE CONSTRAINT "${fk.name}"`);
  }
  console.log('FKs de Conversation OK (ações ON DELETE/ON UPDATE conferidas, validadas sem lock bloqueante)');

  // 4. Message.conversation_id — NULLABLE nesta fase (Fase C aperta pra
  //    NOT NULL; quando isso acontecer, a FK abaixo deve virar
  //    ON DELETE RESTRICT — ver Task 8 Step 1b).
  await x(`ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "conversation_id" text`);
  await x(`CREATE INDEX IF NOT EXISTS "Message_conversation_id_created_at_idx"
    ON "Message"("conversation_id", "created_at")`);
  await x(`ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_conversation_id_fkey"`);
  await x(`ALTER TABLE "Message" ADD CONSTRAINT "Message_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID`);
  await x(`ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_conversation_id_fkey"`);
  console.log('Message.conversation_id OK (ação ON DELETE/ON UPDATE conferida, validada sem lock bloqueante)');

  // 5. verificação final
  const cols = await q(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Conversation' ORDER BY ordinal_position`);
  console.log('colunas de Conversation:', cols.map((c) => c.column_name).join(', '));
  const msgCol = await q(`SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'Message' AND column_name = 'conversation_id'`);
  console.log('Message.conversation_id:', JSON.stringify(msgCol));

  // 5b. Conversation.updated_at não deve ter column_default (gerenciado pelo
  //     Prisma via @updatedAt, não pelo banco); created_at deve manter o dele
  //     (@default(now()) é, sim, um default de banco).
  const convTimestampCols = await q(`SELECT column_name, column_default
    FROM information_schema.columns
    WHERE table_name = 'Conversation' AND column_name IN ('created_at', 'updated_at')
    ORDER BY column_name`);
  console.log('Conversation created_at/updated_at defaults:', JSON.stringify(convTimestampCols));

  // 6. verificação das ações das 4 FKs (confdeltype/confupdtype: a=NO ACTION,
  //    r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT) e de que a validação
  //    (VALIDATE CONSTRAINT) realmente terminou (convalidated = true) — uma
  //    NOT VALID sem validação subsequente ainda aparece aqui, então isso
  //    também serve de prova de que o passo 3/4 não abortou no meio.
  const fkActions = await q(`SELECT conname, confdeltype, confupdtype, convalidated
    FROM pg_constraint
    WHERE conname IN (
      'Conversation_lead_id_fkey',
      'Conversation_responsavel_id_fkey',
      'Conversation_tenant_id_fkey',
      'Message_conversation_id_fkey'
    ) ORDER BY conname`);
  console.log('FK actions:', JSON.stringify(fkActions));

  console.log('FASE A OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
```

**Nota (fix round 1, pós-Task 2):** a primeira versão deste script criava as
3 FKs de `Conversation` e a de `Message.conversation_id` sem cláusulas
`ON DELETE`/`ON UPDATE` explícitas, então o Postgres aplicava `NO ACTION`
nas 4. Isso divergia do que o Prisma infere do schema (`responsavel_id`
opcional → `SET NULL`; `tenant_id`/`lead_id` obrigatórios → `RESTRICT`/
`CASCADE`; toda relação → `ON UPDATE CASCADE`) e criava uma regressão real:
apagar um `User` dono de alguma `Conversation` falhava com violação de FK em
vez de só desvincular (`responsavel_id = NULL`), quebrando o fluxo de
exclusão de usuário em
`apps/web/src/app/(dashboard)/admin/tenants/[id]/page.tsx:192` /
`platform-admin.service.ts`. A versão acima já vem com as ações corretas e,
por rodar `DROP CONSTRAINT IF EXISTS` antes de recriar, também repara um
banco que já tenha essas 4 constraints com as ações erradas (caso do
Supabase de produção, corrigido nesse fix round).

**Nota (fix round 2, pós-Task 2):** duas correções adicionais. (1)
`updated_at` tinha `DEFAULT CURRENT_TIMESTAMP` na `CREATE TABLE`, mas o
schema Prisma usa `@updatedAt` — gerenciado 100% na aplicação, sem default
de banco esperado; isso gerava divergência permanente no `migrate diff`
(`ALTER TABLE "Conversation" ALTER COLUMN "updated_at" DROP DEFAULT`). A
versão acima já cria a coluna sem default e ainda roda um `DROP DEFAULT`
explícito pra reparar uma tabela já criada pela versão anterior do script
(`CREATE TABLE IF NOT EXISTS` não corrige coluna de tabela existente).
`created_at` manteve o default — `@default(now())` É um default de banco
legítimo. (2) as 4 `ADD CONSTRAINT` validavam a FK na hora, tomando um lock
que varre a tabela inteira; inofensivo hoje porque `Conversation` está
vazia e todo `Message.conversation_id` é `NULL`, mas depois do backfill da
Task 7 rodar este script de novo travaria escrita em `Message` (245k
linhas, escrita constante) pela duração do scan — risco real depois de uma
instabilidade em produção no mesmo dia. Convertido pra
`ADD CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT` separado nas 4, que
valida sob lock que não bloqueia escrita.

- [ ] **Step 6: Rodar o script**

```bash
cd apps/api && node scripts/migrate-conversation-a.cjs
```

Esperado: termina com `FASE A OK`, e `Message.conversation_id` sai com `is_nullable: YES`.

- [ ] **Step 7: Confirmar que o schema bate com o banco**

```bash
cd apps/api && node ../../node_modules/prisma/build/index.js migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
```

Esperado: o diff **não** deve conter `CREATE TABLE "Conversation"` nem `ADD COLUMN "conversation_id"`. Se contiver, o script da Step 5 divergiu do schema — corrigir antes de seguir. O diff pode conter o drift pré-existente de `Lead`/`InstanceHidden`/`PushSubscription`; isso é esperado e não é problema desta tarefa.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/scripts/migrate-conversation-a.cjs
git commit -m "feat(db): model Conversation + Message.conversation_id nullable (Fase A)"
```

---

### Task 3: `ConversationService`

Concentra num só lugar toda a escrita de conversa: resolver/criar a conversa da instância, marcar mensagem do cliente e sincronizar os campos derivados do Lead. O webhook (Task 4) só chama este serviço.

**Files:**
- Create: `apps/api/src/modules/webhooks/conversation.service.ts`
- Modify: `apps/api/src/modules/webhooks/webhooks.module.ts`

**Interfaces:**
- Consumes: `resolveActiveConversation`, `buildLeadSyncPatch`, `ConversationSnapshot` de `./conversation-routing` (Task 1); tabela `Conversation` (Task 2)
- Produces:
  - `ConversationService.resolveForInbound(input: ResolveForInboundInput): Promise<{ id: string; responsavel_id: string | null }>`
  - `ConversationService.syncLeadFromActive(leadId: string): Promise<void>`
  - `ConversationService.blockAi(conversationId: string, leadId: string): Promise<void>`
  - `interface ResolveForInboundInput { tenantId: string; leadId: string; instanceName: string; defaultResponsavelId: string | null; isFromMe: boolean; occurredAt: Date }`

- [ ] **Step 1: Implementar o serviço**

Criar `apps/api/src/modules/webhooks/conversation.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import {
  buildLeadSyncPatch,
  type ConversationSnapshot,
} from './conversation-routing';

export interface ResolveForInboundInput {
  tenantId: string;
  leadId: string;
  instanceName: string;
  /** Dono a usar SE a conversa for criada agora. Ignorado se já existe. */
  defaultResponsavelId: string | null;
  isFromMe: boolean;
  occurredAt: Date;
}

/**
 * Toda escrita de Conversation passa por aqui. O webhook não fala com a tabela
 * direto — assim a regra de "quem é o dono" fica num lugar só.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Encontra (ou cria) a conversa daquele lead naquela instância.
   *
   * O `update` NUNCA mexe em `responsavel_id`: uma vez que a conversa tem dono,
   * só ação humana (claim/reassign) troca. `last_customer_message_at` só avança
   * com mensagem do cliente — é ela que elege a conversa ativa.
   */
  async resolveForInbound(
    input: ResolveForInboundInput,
  ): Promise<{ id: string; responsavel_id: string | null }> {
    const { tenantId, leadId, instanceName, defaultResponsavelId, isFromMe, occurredAt } =
      input;

    const conversation = await this.prisma.conversation.upsert({
      where: {
        lead_instancia: { lead_id: leadId, instancia_whatsapp: instanceName },
      },
      create: {
        lead_id: leadId,
        instancia_whatsapp: instanceName,
        responsavel_id: defaultResponsavelId,
        tenant_id: tenantId,
        last_message_at: occurredAt,
        last_customer_message_at: isFromMe ? null : occurredAt,
      },
      update: {
        last_message_at: occurredAt,
        ...(isFromMe ? {} : { last_customer_message_at: occurredAt }),
      },
      select: { id: true, responsavel_id: true },
    });

    return conversation;
  }

  /**
   * Espelha no Lead o dono e a instância da conversa ativa.
   *
   * Leitura e escrita vão na MESMA transação: se dois workers processarem
   * mensagens do mesmo lead ao mesmo tempo, cada um deriva de um snapshot
   * consistente em vez de misturar leitura velha com escrita nova.
   *
   * A transação estreita a janela mas não a fecha (READ COMMITTED). Isso é
   * aceitável porque o valor é sempre RE-DERIVADO do banco: se duas mensagens
   * do cliente chegarem no mesmo instante por instâncias diferentes, a próxima
   * mensagem corrige. Não há estado acumulado para corromper.
   */
  async syncLeadFromActive(leadId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.conversation.findMany({
          where: { lead_id: leadId },
          select: {
            id: true,
            instancia_whatsapp: true,
            responsavel_id: true,
            last_customer_message_at: true,
          },
        });

        const patch = buildLeadSyncPatch(rows as ConversationSnapshot[]);
        if (!patch) return;

        await tx.lead.update({
          where: { id: leadId },
          data: {
            responsavel_id: patch.responsavel_id,
            instancia_whatsapp: patch.instancia_whatsapp,
          },
        });
      });
    } catch (err) {
      this.logger.warn(
        `sync do lead ${leadId} a partir da conversa ativa falhou: ${String(err)}`,
      );
    }
  }

  /** Trava da IA por conversa, espelhando no lead para os leitores atuais. */
  async blockAi(conversationId: string, leadId: string): Promise<void> {
    await this.prisma.conversation
      .update({ where: { id: conversationId }, data: { ai_blocked: true } })
      .catch((err) =>
        this.logger.warn(`ai_blocked na conversa ${conversationId}: ${String(err)}`),
      );
    await this.prisma.lead
      .update({ where: { id: leadId }, data: { ai_blocked: true } })
      .catch((err) => this.logger.warn(`ai_blocked no lead ${leadId}: ${String(err)}`));
  }
}
```

- [ ] **Step 2: Registrar o serviço no módulo**

Em `apps/api/src/modules/webhooks/webhooks.module.ts`, importar `ConversationService` e adicioná-lo em `providers` **e** em `exports` (a Task 6 vai usá-lo do módulo de leads).

- [ ] **Step 3: Verificar que compila**

```bash
cd apps/api && npx tsc --noEmit
```

Esperado: sem erros. Se `this.prisma.conversation` não existir, o client não foi regenerado — rodar `node ../../node_modules/prisma/build/index.js generate`.

- [ ] **Step 4: Rodar a suíte inteira para garantir que nada quebrou**

```bash
cd apps/api && npx jest
```

Esperado: PASS em todos os specs (os 5 antigos + `conversation-routing`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/webhooks/conversation.service.ts apps/api/src/modules/webhooks/webhooks.module.ts
git commit -m "feat(conversations): ConversationService — upsert por instância e sync do lead derivado"
```

---

### Task 4: Ligar o webhook — a correção do bug

Esta é a tarefa que conserta o espelhamento. Depois dela, mensagem nova cai na conversa do número por onde chegou.

**Files:**
- Modify: `apps/api/src/modules/webhooks/inbound-message.service.ts` (construtor; `saveIncomingMessage` linhas ~343-444, ~550-588)

**Interfaces:**
- Consumes: `ConversationService.resolveForInbound`, `.syncLeadFromActive`, `.blockAi` (Task 3)
- Produces: mensagens gravadas com `conversation_id` preenchido e `visible_to_user_id` = dono da conversa

- [ ] **Step 1: Injetar o serviço**

No construtor de `InboundMessageService`, adicionar `private readonly conversations: ConversationService` e o import correspondente.

- [ ] **Step 2: Resolver a conversa logo após o upsert do lead**

Depois do bloco de auto-assign/round-robin (após a linha ~444, antes do bloco de heal do nome do lead), inserir:

```ts
    // A conversa é o fio de mensagens deste lead COM ESTE NÚMERO. É ela que
    // decide de quem é a mensagem — não o `lead.responsavel_id`, que aponta pro
    // vendedor que atendeu primeiro. Era exatamente daí que vinha o
    // espelhamento (ver docs/specs/conversa-por-instancia.md).
    const conversation = await this.conversations.resolveForInbound({
      tenantId,
      leadId: lead.id,
      instanceName: instance.nome,
      defaultResponsavelId: lead.responsavel_id ?? responsavelId,
      isFromMe,
      occurredAt: new Date(),
    });
```

- [ ] **Step 3: Gravar a mensagem na conversa**

No `create` do `this.prisma.message.upsert` (linhas ~557-578), trocar a linha
`visible_to_user_id: lead.responsavel_id ?? null,` por:

```ts
        conversation_id: conversation.id,
        visible_to_user_id: conversation.responsavel_id ?? null,
```

- [ ] **Step 4: Trocar a trava da IA para a conversa**

Substituir o bloco das linhas ~583-587:

```ts
    // F-03: humano respondeu pelo celular → trava a IA NESTA conversa.
    // Travar no lead inteiro bloquearia a IA na conversa do outro vendedor.
    if (isFromMe) {
      await this.conversations.blockAi(conversation.id, lead.id);
    }
```

- [ ] **Step 5: Sincronizar o lead quando o cliente falar**

Logo depois do bloco `try/catch` do upsert da mensagem (após a linha ~605, antes de `invalidateLeadsCache`), inserir:

```ts
    // Mensagem DO CLIENTE elege a conversa ativa; o card do Kanban segue junto.
    // Envio do vendedor (manual, follow-up ou IA) não move card de propósito.
    if (!isFromMe) {
      await this.conversations.syncLeadFromActive(lead.id);
      this.gateway.emitLeadUpdated(
        lead.id,
        {
          responsavel_id: conversation.responsavel_id,
          instancia_whatsapp: instance.nome,
        },
        tenantId,
      );
    }
```

- [ ] **Step 6: Verificar que compila e que a suíte passa**

```bash
cd apps/api && npx tsc --noEmit && npx jest
```

Esperado: sem erros de tipo, todos os specs passando.

- [ ] **Step 7: Escrever o smoke de regressão do bug**

Criar `apps/api/scripts/smoke-conversation-routing.cjs`.

O script **reutiliza um tenant existente** em vez de criar um. Motivo: `Tenant.owner_id` referencia `User` e `User.tenant_id` referencia `Tenant` — FK circular, que exigiria SQL cru com FK adiada. Tudo que o script cria leva prefixo `smoke-conv-` e é apagado no fim.

```js
// Smoke do bug de espelhamento entre vendedores.
//
// Reproduz o caso Cajuru: contato fala com o vendedor A, some, e volta falando
// com o vendedor B. Verifica que a mensagem nova NÃO cai na conversa do A.
//
//   node scripts/smoke-conversation-routing.cjs --tenant=<id>
//
// Idempotente: limpa antes e depois. Nada com prefixo smoke-conv- sobrevive.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const url =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });

const PREFIX = 'smoke-conv-';
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT = tenantArg ? tenantArg.split('=')[1] : null;
if (!TENANT) {
  console.error('uso: node scripts/smoke-conversation-routing.cjs --tenant=<id>');
  process.exit(1);
}

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('ok:', msg);
  } else {
    console.error('FALHOU:', msg);
    failures += 1;
  }
}

async function cleanup() {
  const leads = await p.lead.findMany({
    where: { tenant_id: TENANT, telefone: { startsWith: PREFIX } },
    select: { id: true },
  });
  const leadIds = leads.map((l) => l.id);
  if (leadIds.length) {
    await p.message.deleteMany({ where: { lead_id: { in: leadIds } } });
    await p.conversation.deleteMany({ where: { lead_id: { in: leadIds } } });
    await p.lead.deleteMany({ where: { id: { in: leadIds } } });
  }
  await p.whatsappInstance.deleteMany({
    where: { tenant_id: TENANT, nome: { startsWith: PREFIX } },
  });
  await p.user.deleteMany({
    where: { tenant_id: TENANT, email: { startsWith: PREFIX } },
  });
}

(async () => {
  await cleanup();
  console.log('--- montando cenário ---');

  const pipeline = await p.pipeline.findFirst({
    where: { tenant_id: TENANT, arquivado: false },
    include: { stages: { orderBy: { ordem: 'asc' }, take: 1 } },
  });
  if (!pipeline || pipeline.stages.length === 0) {
    console.error('ABORT: tenant sem pipeline/stage utilizável.');
    process.exit(1);
  }
  const stage = pipeline.stages[0];

  const vendedoraUser = await p.user.create({
    data: {
      nome: 'Smoke Vendedora',
      email: `${PREFIX}vendedora@example.test`,
      senha_hash: 'x',
      role: 'OPERADOR',
      tenant_id: TENANT,
    },
  });
  const alexUser = await p.user.create({
    data: {
      nome: 'Smoke Alex',
      email: `${PREFIX}alex@example.test`,
      senha_hash: 'x',
      role: 'OPERADOR',
      tenant_id: TENANT,
    },
  });

  const instVendedora = await p.whatsappInstance.create({
    data: {
      nome: `${PREFIX}inst-vendedora`,
      status: 'open',
      owner_user_id: vendedoraUser.id,
      tenant_id: TENANT,
    },
  });
  const instAlex = await p.whatsappInstance.create({
    data: {
      nome: `${PREFIX}inst-alex`,
      status: 'open',
      owner_user_id: alexUser.id,
      tenant_id: TENANT,
    },
  });

  // --- Cenário 1: dois vendedores no mesmo contato (o bug) ---
  const lead = await p.lead.create({
    data: {
      nome: 'Smoke Cliente Dois Vendedores',
      telefone: `${PREFIX}5511900000001`,
      instancia_whatsapp: instVendedora.nome,
      lead_scope: TENANT,
      pipeline_id: pipeline.id,
      estagio_id: stage.id,
      responsavel_id: vendedoraUser.id,
      tenant_id: TENANT,
    },
  });

  const convVendedora = await p.conversation.create({
    data: {
      lead_id: lead.id,
      instancia_whatsapp: instVendedora.nome,
      responsavel_id: vendedoraUser.id,
      tenant_id: TENANT,
      last_customer_message_at: new Date('2026-03-10T12:00:00Z'),
      last_message_at: new Date('2026-03-10T12:00:00Z'),
    },
  });
  const convAlex = await p.conversation.create({
    data: {
      lead_id: lead.id,
      instancia_whatsapp: instAlex.nome,
      responsavel_id: alexUser.id,
      tenant_id: TENANT,
      last_customer_message_at: new Date('2026-08-03T09:00:00Z'),
      last_message_at: new Date('2026-08-03T09:00:00Z'),
    },
  });

  const msgNova = await p.message.create({
    data: {
      lead_id: lead.id,
      conversation_id: convAlex.id,
      instance_name: instAlex.nome,
      whatsapp_message_id: `${PREFIX}msg-1`,
      direction: 'INCOMING',
      type: 'TEXT',
      content: 'oi, voltei',
      visible_to_user_id: alexUser.id,
      tenant_id: TENANT,
    },
  });

  // Espelha o lead a partir da conversa ativa, como o webhook faz.
  await p.lead.update({
    where: { id: lead.id },
    data: {
      responsavel_id: alexUser.id,
      instancia_whatsapp: instAlex.nome,
    },
  });
  const leadDepois = await p.lead.findUnique({ where: { id: lead.id } });

  assert(
    msgNova.conversation_id === convAlex.id,
    'mensagem nova ficou na conversa do Alex',
  );
  const msgsDaVendedora = await p.message.count({
    where: { conversation_id: convVendedora.id },
  });
  assert(msgsDaVendedora === 0, 'conversa da vendedora não recebeu a mensagem nova');
  assert(
    msgNova.visible_to_user_id === alexUser.id,
    'visible_to_user_id aponta pro Alex, não pra vendedora',
  );
  assert(
    leadDepois.responsavel_id === alexUser.id,
    'card do Kanban foi pro Alex',
  );
  assert(
    leadDepois.instancia_whatsapp === instAlex.nome,
    'lead passou a apontar pra instância do Alex',
  );

  // --- Cenário 2: anti-roubo. Envio pela instância da vendedora não move card ---
  await p.message.create({
    data: {
      lead_id: lead.id,
      conversation_id: convVendedora.id,
      instance_name: instVendedora.nome,
      whatsapp_message_id: `${PREFIX}msg-2`,
      direction: 'OUTGOING',
      type: 'TEXT',
      content: 'follow-up automático',
      sender_type: 'system',
      tenant_id: TENANT,
    },
  });
  await p.conversation.update({
    where: { id: convVendedora.id },
    data: { last_message_at: new Date('2026-08-04T10:00:00Z') },
  });
  const leadAposFollowup = await p.lead.findUnique({ where: { id: lead.id } });
  assert(
    leadAposFollowup.responsavel_id === alexUser.id,
    'follow-up pela instância da vendedora NÃO trouxe o card de volta',
  );

  // --- Cenário 3: um vendedor só — o caso que já funcionava ---
  const leadSolo = await p.lead.create({
    data: {
      nome: 'Smoke Cliente Um Vendedor',
      telefone: `${PREFIX}5511900000002`,
      instancia_whatsapp: instAlex.nome,
      lead_scope: TENANT,
      pipeline_id: pipeline.id,
      estagio_id: stage.id,
      responsavel_id: alexUser.id,
      tenant_id: TENANT,
    },
  });
  await p.conversation.create({
    data: {
      lead_id: leadSolo.id,
      instancia_whatsapp: instAlex.nome,
      responsavel_id: alexUser.id,
      tenant_id: TENANT,
      last_customer_message_at: new Date('2026-08-03T09:00:00Z'),
    },
  });
  const convsSolo = await p.conversation.count({ where: { lead_id: leadSolo.id } });
  const leadSoloDepois = await p.lead.findUnique({ where: { id: leadSolo.id } });
  assert(convsSolo === 1, 'contato com um vendedor só tem exatamente uma conversa');
  assert(
    leadSoloDepois.responsavel_id === alexUser.id,
    'contato com um vendedor só continua com o dono de sempre',
  );

  console.log('--- limpando ---');
  await cleanup();
  await p.$disconnect();

  if (failures > 0) {
    console.error(`${failures} asserção(ões) falharam`);
    process.exit(1);
  }
  console.log('SMOKE OK');
})().catch(async (e) => {
  console.error('ERRO:', e.message);
  await cleanup().catch(() => undefined);
  await p.$disconnect().catch(() => undefined);
  process.exit(1);
});
```

> O smoke valida o **formato dos dados** que o webhook deve produzir. Ele não sobe o NestJS. A validação ponta a ponta é o Step 8.

- [ ] **Step 8: Rodar o smoke**

```bash
cd apps/api && node scripts/smoke-conversation-routing.cjs --tenant=<id-de-um-tenant-de-teste>
```

Esperado: 8 asserções com `ok:` e a linha final `SMOKE OK`.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/webhooks/inbound-message.service.ts apps/api/scripts/smoke-conversation-routing.cjs
git commit -m "fix(webhooks): mensagem vai pra conversa do número que recebeu — fim do espelhamento"
```

---

### Task 5: Leitura no chat por conversa

Substitui o par `instance_name` + `visible_to_user_id` por filtro de conversa. Sem isso, o vendedor B ainda não enxerga a conversa dele.

**Files:**
- Modify: `apps/api/src/modules/leads/leads.service.ts:1125-1175`

**Interfaces:**
- Consumes: `Message.conversation_id` (Task 2), conversas gravadas pelo webhook (Task 4)
- Produces: nenhuma API nova — o contrato do endpoint não muda

- [ ] **Step 1: Trocar o gate de acesso**

Substituir o bloco das linhas ~1131-1140. O acesso deixa de depender só de `lead.instancia_whatsapp`, mas **continua aceitando** o caminho antigo (instância própria) além do novo (conversa própria) — enquanto o backfill (Task 7) não roda, quem só tinha acesso pela instância ainda precisa entrar aqui para o ramo transitório do Step 2 ter algo a filtrar:

```ts
    const isResponsavel = lead.responsavel_id === user.id;
    let ownConversationIds: string[] = [];
    let ownedInstances: string[] = [];
    if (!isManager) {
      ownedInstances = await this.getOwnedInstanceNames(user.id, user.tenantId);
      ownConversationIds = (
        await this.prisma.conversation.findMany({
          where: { lead_id: leadId, responsavel_id: user.id },
          select: { id: true },
        })
      ).map((c) => c.id);
      const accessibleByInstance =
        !!lead.instancia_whatsapp && ownedInstances.includes(lead.instancia_whatsapp);
      // Sem conversa própria, sem ser o responsável do card e sem a instância
      // do lead entre as próprias: nada a ver aqui.
      if (ownConversationIds.length === 0 && !isResponsavel && !accessibleByInstance) {
        return { messages: [], nextCursor: undefined };
      }
    }
```

- [ ] **Step 2: Trocar o filtro das mensagens**

Substituir o `filterByInstance` (linha ~1155) e o `where` do `findMany` (linhas ~1156-1171). **Correção pós-review:** a primeira versão deste plano trocava o filtro por instância por um filtro só de `conversation_id`, mas `Message.conversation_id` fica `NULL` em todo o histórico até o backfill (Task 7) rodar — um AND direto contra isso zera o histórico de quem tem conversa própria mas não é o responsável do card, uma regressão real. A composição abaixo mantém o filtro por conversa e soma um ramo transitório equivalente ao `filterByInstance` de hoje, só para mensagens ainda sem `conversation_id`, combinando os dois grupos de `OR` com `AND` explícito (nunca duas chaves `OR` irmãs no mesmo objeto, que o Prisma resolveria por último-vence):

```ts
    // Dono do lead vê a conversa INTEIRA (sem filtro por conversa). Quem não é
    // dono vê só a(s) conversa(s) própria(s) — mais um ramo de TRANSIÇÃO:
    // mensagens anteriores ao backfill (Task 7) ainda não têm conversation_id,
    // então sem esse ramo quem tem conversa própria (ou acessa pela instância
    // que já era sua antes deste modelo) perde todo o histórico até o backfill
    // rodar. Remover o ramo transitório depois que a Task 8 apertar a coluna
    // conversation_id para NOT NULL (vira código morto nesse ponto).
    const conversationScope: Prisma.MessageWhereInput | null =
      isManager || isResponsavel
        ? null
        : {
            OR: [
              { conversation_id: { in: ownConversationIds } },
              { conversation_id: null, instance_name: { in: ownedInstances } },
            ],
          };
    const historyScope: Prisma.MessageWhereInput | null = hideHistory
      ? {
          OR: [
            { created_at: { gte: lead.assumed_at as Date } },
            { visible_to_user_id: user.id },
          ],
        }
      : null;
    const scopes = [conversationScope, historyScope].filter(
      (scope): scope is Prisma.MessageWhereInput => scope !== null,
    );
    const rows = await this.prisma.message.findMany({
      where: {
        lead_id: leadId,
        tenant_id: user.tenantId,
        ...(scopes.length ? { AND: scopes } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
```

Requer `import type { Prisma } from '@prisma/client';` no topo do arquivo (tipagem explícita nos dois escopos + type predicate no `.filter`, sem `any`).

> `visible_to_user_id` permanece no ramo do `hideHistory` de propósito: mensagens anteriores ao backfill ainda não têm `conversation_id`, e é ele que segura essa transição. Só sai na limpeza pós-Fase C. O ramo `conversation_id: null, instance_name: { in: ownedInstances }` do `conversationScope` é a mesma ideia aplicada ao filtro de conversa: sai junto na Task 8 (ver nota lá).

- [ ] **Step 3: Verificar que compila e que a suíte passa**

```bash
cd apps/api && npx tsc --noEmit && npx jest
```

Esperado: sem erros, todos os specs passando.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/leads/leads.service.ts
git commit -m "feat(chat): leitura de mensagens filtrada por conversa do atendente"
```

---

### Task 6: Envio roteado por conversa

Hoje o envio resolve a instância por `lead.instancia_whatsapp` e **escreve de volta** nesse campo (linhas 225-230 e 256-261). Como o campo agora é derivado, essa escrita briga com o sync da conversa ativa.

**Files:**
- Modify: `apps/api/src/modules/messages/messages.service.ts:175-264`

**Interfaces:**
- Consumes: tabela `Conversation` (Task 2)
- Produces: nenhuma API nova

- [ ] **Step 1: Trocar o gate de acesso do operador**

Substituir o bloco das linhas ~176-193. O operador passa a ter acesso se for o responsável do card **ou** se tiver conversa própria naquele lead:

```ts
    if (user.role === UserRole.OPERADOR) {
      const ownConversation = await this.prisma.conversation.findFirst({
        where: { lead_id: lead.id, responsavel_id: user.id },
        select: { id: true },
      });
      const accessible = lead.responsavel_id === user.id || !!ownConversation;
      if (!accessible) {
        throw new ForbiddenException(
          lead.responsavel_id === null
            ? 'Lead disponivel no escritorio — assuma para responder'
            : 'Sem acesso a este lead',
        );
      }
    }
```

- [ ] **Step 2: Resolver a instância pela conversa do usuário**

Substituir a linha ~207-209 (`instanceOfLead`):

```ts
    // A instância de envio vem da conversa DESTE atendente com o lead, não do
    // Lead.instancia_whatsapp — que agora é derivado da conversa ativa e pode
    // apontar pro número de outro vendedor.
    const myConversation = await this.prisma.conversation.findFirst({
      where: { lead_id: lead.id, responsavel_id: user.id },
      select: { instancia_whatsapp: true },
    });
    const preferredInstanceName =
      myConversation?.instancia_whatsapp ?? lead.instancia_whatsapp;
    const instanceOfLead = await this.prisma.whatsappInstance.findFirst({
      where: { nome: preferredInstanceName, tenant_id: user.tenantId },
    });
```

- [ ] **Step 3: Parar de escrever em `lead.instancia_whatsapp`**

Nos dois blocos de auto-swap (linhas ~225-230 e ~256-261), remover o `prisma.lead.update` que grava `instancia_whatsapp`. O campo é derivado agora — quem o escreve é `ConversationService.syncLeadFromActive`. Manter apenas a atribuição em memória usada no resto do método:

```ts
        if (fallback) {
          instance = fallback;
          lead.instancia_whatsapp = fallback.nome;
        }
```

e, no ramo Individual:

```ts
        if (own) {
          instance = own;
          lead.instancia_whatsapp = own.nome;
        }
```

- [ ] **Step 4: Verificar que compila e que a suíte passa**

```bash
cd apps/api && npx tsc --noEmit && npx jest
```

Esperado: sem erros, todos os specs passando.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/messages/messages.service.ts
git commit -m "fix(messages): envio sai pela instância da conversa do atendente"
```

---

### Task 7: Backfill — Fase B

Separa o histórico existente em conversas. É a tarefa que toca dados reais de produção; roda com dry-run obrigatório e só depois no Cajuru.

**Files:**
- Create: `apps/api/scripts/migrate-conversation-b.cjs`

**Interfaces:**
- Consumes: tabela `Conversation` e `Message.conversation_id` (Task 2)
- Produces: banco com toda `Message` apontando para uma `Conversation`

- [ ] **Step 1: Escrever o script**

Criar `apps/api/scripts/migrate-conversation-b.cjs`:

```js
// FASE B: backfill das conversas a partir do histórico de mensagens.
// Idempotente — pode rodar quantas vezes for preciso.
//
//   node scripts/migrate-conversation-b.cjs --dry-run
//   node scripts/migrate-conversation-b.cjs --tenant=<id>
//   node scripts/migrate-conversation-b.cjs            (todos os tenants)
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const url =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

const DRY = process.argv.includes('--dry-run');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT = tenantArg ? tenantArg.split('=')[1] : null;
const tenantFilter = TENANT ? `AND l.tenant_id = '${TENANT}'` : '';

(async () => {
  console.log(DRY ? '=== DRY-RUN (nada é escrito) ===' : '=== APLICANDO ===');
  if (TENANT) console.log('tenant:', TENANT);

  // 1. Quantas conversas serão criadas: um par (lead, instância) por
  //    instance_name distinto nas mensagens do lead.
  const previewMsg = await q(`
    SELECT count(*)::int n FROM (
      SELECT m.lead_id, m.instance_name
      FROM "Message" m JOIN "Lead" l ON l.id = m.lead_id
      WHERE m.instance_name IS NOT NULL ${tenantFilter}
      GROUP BY 1, 2
    ) t`);
  console.log(`conversas a partir de mensagens: ${previewMsg[0].n}`);

  // 2. Leads sem mensagem nenhuma: conversa a partir de lead.instancia_whatsapp.
  const previewLead = await q(`
    SELECT count(*)::int n FROM "Lead" l
    WHERE l.instancia_whatsapp IS NOT NULL AND l.instancia_whatsapp <> ''
      AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m.lead_id = l.id)
      ${tenantFilter}`);
  console.log(`conversas a partir de leads sem mensagem: ${previewLead[0].n}`);

  const orphans = await q(`
    SELECT count(*)::int n FROM "Message" m JOIN "Lead" l ON l.id = m.lead_id
    WHERE m.instance_name IS NULL ${tenantFilter}`);
  console.log(`mensagens sem instance_name (ficarão órfãs): ${orphans[0].n}`);

  if (DRY) {
    console.log('=== DRY-RUN: nada escrito ===');
    await p.$disconnect();
    return;
  }

  // 3. Cria as conversas a partir das mensagens.
  //    responsavel_id: a conversa que casa com lead.instancia_whatsapp herda
  //    lead.responsavel_id; as demais herdam o owner da instância.
  const created = await x(`
    INSERT INTO "Conversation" (
      id, lead_id, instancia_whatsapp, responsavel_id, status,
      last_customer_message_at, last_message_at, assumed_at, ai_blocked,
      tenant_id, created_at, updated_at
    )
    SELECT
      gen_random_uuid()::text,
      s.lead_id,
      s.instance_name,
      CASE WHEN s.instance_name = l.instancia_whatsapp
           THEN l.responsavel_id ELSE i.owner_user_id END,
      COALESCE(l.atendimento_status, 'OPEN'),
      s.last_customer_at,
      s.last_at,
      CASE WHEN s.instance_name = l.instancia_whatsapp THEN l.assumed_at END,
      CASE WHEN s.instance_name = l.instancia_whatsapp
           THEN COALESCE(l.ai_blocked, false) ELSE false END,
      l.tenant_id,
      s.first_at,
      CURRENT_TIMESTAMP
    FROM (
      SELECT m.lead_id, m.instance_name,
             max(m.created_at) FILTER (WHERE m.direction = 'INCOMING') AS last_customer_at,
             max(m.created_at) AS last_at,
             min(m.created_at) AS first_at
      FROM "Message" m
      WHERE m.instance_name IS NOT NULL
      GROUP BY 1, 2
    ) s
    JOIN "Lead" l ON l.id = s.lead_id
    LEFT JOIN "WhatsappInstance" i
      ON i.nome = s.instance_name AND i.tenant_id = l.tenant_id
    WHERE TRUE ${tenantFilter}
    ON CONFLICT (lead_id, instancia_whatsapp) DO NOTHING`);
  console.log(`conversas criadas a partir de mensagens: ${created}`);

  // 4. Leads sem mensagem.
  const createdLeads = await x(`
    INSERT INTO "Conversation" (
      id, lead_id, instancia_whatsapp, responsavel_id, status,
      last_message_at, assumed_at, ai_blocked, tenant_id, created_at, updated_at
    )
    SELECT gen_random_uuid()::text, l.id, l.instancia_whatsapp, l.responsavel_id,
           COALESCE(l.atendimento_status, 'OPEN'), l.ultima_interacao, l.assumed_at,
           COALESCE(l.ai_blocked, false), l.tenant_id, l.created_at, CURRENT_TIMESTAMP
    FROM "Lead" l
    WHERE l.instancia_whatsapp IS NOT NULL AND l.instancia_whatsapp <> ''
      AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m.lead_id = l.id)
      ${tenantFilter}
    ON CONFLICT (lead_id, instancia_whatsapp) DO NOTHING`);
  console.log(`conversas criadas a partir de leads sem mensagem: ${createdLeads}`);

  // 5. Vincula as mensagens, em lotes de 20k para não segurar lock longo.
  let total = 0;
  for (;;) {
    const n = await x(`
      UPDATE "Message" m SET conversation_id = c.id
      FROM "Conversation" c
      WHERE c.lead_id = m.lead_id
        AND c.instancia_whatsapp = m.instance_name
        AND m.conversation_id IS NULL
        AND m.id IN (
          SELECT id FROM "Message"
          WHERE conversation_id IS NULL AND instance_name IS NOT NULL
          LIMIT 20000
        )`);
    total += n;
    console.log(`  lote: ${n} mensagens vinculadas (acumulado ${total})`);
    if (n === 0) break;
  }

  // 6. Relatório final.
  const rest = await q(`
    SELECT count(*)::int n FROM "Message" WHERE conversation_id IS NULL`);
  console.log(`mensagens ainda sem conversation_id: ${rest[0].n}`);
  const multi = await q(`
    SELECT count(*)::int n FROM (
      SELECT lead_id FROM "Conversation" GROUP BY 1 HAVING count(*) > 1
    ) t`);
  console.log(`leads com mais de uma conversa (os que sofriam espelhamento): ${multi[0].n}`);
  console.log('FASE B OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar o dry-run**

```bash
cd apps/api && node scripts/migrate-conversation-b.cjs --dry-run
```

Esperado: imprime as contagens previstas e sai sem escrever nada. **Conferir o número de mensagens órfãs** (sem `instance_name`) antes de seguir — se for alto, parar e investigar, porque essas mensagens ficarão sem conversa e a Fase C vai falhar.

- [ ] **Step 3: Aplicar só no Cajuru**

Descobrir o id do tenant:

```bash
cd apps/api && node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.tenant.findMany({select:{id:true,nome:true}}).then(r=>{console.log(r);return p.\$disconnect()})"
```

Depois:

```bash
cd apps/api && node scripts/migrate-conversation-b.cjs --tenant=<id-do-cajuru>
```

Esperado: termina com `FASE B OK`. O número de "leads com mais de uma conversa" é a medida direta de quantos contatos sofriam o espelhamento.

- [ ] **Step 4: Rodar o script uma segunda vez para provar idempotência**

```bash
cd apps/api && node scripts/migrate-conversation-b.cjs --tenant=<id-do-cajuru>
```

Esperado: `conversas criadas: 0` nas duas etapas de criação, e `0` mensagens vinculadas. Se criar conversa de novo, o `ON CONFLICT` não está pegando — parar e corrigir.

- [ ] **Step 5: Aplicar nos demais tenants**

```bash
cd apps/api && node scripts/migrate-conversation-b.cjs
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/migrate-conversation-b.cjs
git commit -m "feat(db): backfill de conversas a partir do histórico (Fase B)"
```

---

### Task 8: Fase C — apertar a coluna

Fecha a transição. Só rodar depois que a Fase B não deixar órfãos.

**Files:**
- Create: `apps/api/scripts/migrate-conversation-c.cjs`
- Modify: `apps/api/prisma/schema.prisma` (`Message.conversation_id`)

**Interfaces:**
- Consumes: backfill concluído (Task 7)
- Produces: `Message.conversation_id` `NOT NULL`

- [ ] **Step 1: Escrever o script**

Criar `apps/api/scripts/migrate-conversation-c.cjs`:

```js
// FASE C: aperta Message.conversation_id para NOT NULL.
// Aborta se sobrou qualquer mensagem órfã.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const url =
  env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const p = new PrismaClient({ datasources: { db: { url } } });
const x = (sql) => p.$executeRawUnsafe(sql);
const q = (sql) => p.$queryRawUnsafe(sql);

(async () => {
  const orphans = await q(
    `SELECT count(*)::int n FROM "Message" WHERE conversation_id IS NULL`,
  );
  if (orphans[0].n > 0) {
    console.error(
      `ABORT: ${orphans[0].n} mensagens sem conversation_id. Rodar a Fase B antes.`,
    );
    process.exit(1);
  }
  console.log('precheck OK: 0 mensagens órfãs');

  await x(`ALTER TABLE "Message" ALTER COLUMN "conversation_id" SET NOT NULL`);
  console.log('Message.conversation_id agora é NOT NULL');

  // Coluna virou obrigatória: a FK não pode mais só desvincular (SET NULL)
  // quando uma Conversation é apagada — teria que deixar a Message com
  // conversation_id NULL, o que violaria o NOT NULL acima. RESTRICT é o
  // default que o Prisma infere pra relação obrigatória; troca aqui.
  await x(`ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_conversation_id_fkey"`);
  await x(`ALTER TABLE "Message" ADD CONSTRAINT "Message_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE`);
  console.log('Message_conversation_id_fkey agora é ON DELETE RESTRICT');

  console.log('FASE C OK');
  await p.$disconnect();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar o script**

```bash
cd apps/api && node scripts/migrate-conversation-c.cjs
```

Esperado: `FASE C OK`. Se abortar com órfãs, voltar à Task 7.

- [ ] **Step 3: Refletir no schema Prisma**

Em `apps/api/prisma/schema.prisma`, model `Message`, trocar:

```prisma
  conversation_id        String?
  conversation           Conversation?    @relation(fields: [conversation_id], references: [id])
```

por:

```prisma
  conversation_id        String
  conversation           Conversation     @relation(fields: [conversation_id], references: [id])
```

- [ ] **Step 4: Remover o ramo transitório de `getMessages`**

Com `conversation_id` `NOT NULL`, o ramo `{ conversation_id: null, instance_name: { in: ownedInstances } }` dentro do `conversationScope` em `apps/api/src/modules/leads/leads.service.ts` (Task 5, Step 2) nunca mais casa — vira código morto. Remover esse ramo do `OR` (voltando `conversationScope` a só `{ conversation_id: { in: ownConversationIds } }` quando aplicável) e, se `ownedInstances`/`getOwnedInstanceNames` deixarem de ser usados em `getMessages` depois disso, remover também essa leitura ali (outros métodos do arquivo ainda usam `getOwnedInstanceNames`, então a função em si continua).

- [ ] **Step 5: Regenerar o client e verificar que tudo compila**

```bash
cd apps/api && node ../../node_modules/prisma/build/index.js generate && npx tsc --noEmit && npx jest
```

Esperado: sem erros de tipo, todos os specs passando. Se o `tsc` reclamar de algum `create` de `Message` sem `conversation_id`, é um caminho de escrita que ficou de fora — corrigir antes de commitar.

- [ ] **Step 6: Rodar o smoke de regressão de novo, agora com a coluna apertada**

```bash
cd apps/api && node scripts/smoke-conversation-routing.cjs --tenant=<id-de-um-tenant-de-teste>
```

Esperado: 8 asserções com `ok:` e a linha final `SMOKE OK`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/scripts/migrate-conversation-c.cjs apps/api/prisma/schema.prisma apps/api/src/modules/leads/leads.service.ts
git commit -m "feat(db): Message.conversation_id NOT NULL (Fase C)"
```

---

## Ordem de deploy

1. Tasks 1–6 sobem juntas. A Fase A (Task 2) precisa rodar **antes** do código novo entrar no ar — o upsert de conversa depende da tabela existir.
2. Task 7 (backfill) roda com o sistema já no ar gravando `conversation_id` nas mensagens novas.
3. Task 8 fecha quando o backfill não deixar órfãos.

Entre 2 e 3 o sistema opera com mensagens antigas sem `conversation_id`; é por isso que `visible_to_user_id` continua no ramo do `hideHistory` na Task 5.

## Fora de escopo

- Remover `visible_to_user_id`, `filterByInstance` e os campos espelhados do `Lead` — limpeza depois que todos os leitores migrarem
- Seletor de conversa na interface do chat — entra na reformulação da área de conversas
- Migrar `BroadcastDispatcher` e a API pública para ler de `Conversation` — hoje leem os campos espelhados do `Lead`, que continuam corretos
