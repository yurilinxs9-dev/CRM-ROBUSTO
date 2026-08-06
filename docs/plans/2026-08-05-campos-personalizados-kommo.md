# Campos personalizados (paridade Kommo) — Plano de Implementação

> **Para workers agênticos:** implementar tarefa por tarefa, na ordem. Os passos usam checkbox (`- [ ]`) para rastreamento. Nenhuma tarefa pode ser marcada como feita sem os testes da seção "Verificação" passando.

**Goal:** Levar a ficha do lead ao comportamento do Kommo — painel lateral com abas (Principal / Estatísticas / Mídia / Configurações), campos organizados em grupos criados pela própria empresa, campos nativos e customizados na mesma lista ordenável, e escopos separados para Lead, Contato e Empresa. Cada tenant começa cru: só os campos nativos, nenhum campo de negócio pré-fabricado.

**Architecture:** Três eixos independentes.
1. **Definições** — `CustomFieldDef` ganha `escopo`, `group_id`, `native_key`, `api_only` e `visible`. O novo `CustomFieldGroup` é a aba/seção que a empresa cria. Campos nativos entram na mesma lista como defs com `native_key` preenchida: o rótulo e a ordem vêm do def, mas leitura e escrita vão para a coluna real do registro, não para o Json.
2. **Contato e Empresa** — entidades novas (`Contact`, `Company`, `LeadContact`), **puramente aditivas**. O `Lead` não recebe nenhuma coluna nova e nenhuma coluna existente muda de tipo. Leads já existentes continuam funcionando exatamente como hoje, com zero contatos vinculados.
3. **UI** — os dois painéis de lead (Kanban e Chat) passam a renderizar o schema vindo da API em vez de campos hardcoded, e o editor de campos vira a aba "Configurações" do próprio painel.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL (Supabase), Zod, Jest 30 + ts-jest, Next.js 14 App Router, TanStack Query 5, @dnd-kit, Radix Tabs, Tailwind, lucide-react.

---

## Decisões já tomadas (não reabrir)

| Questão | Decisão |
| --- | --- |
| Contato/Empresa | Entidades reais (`Contact`, `Company`), **sem tocar em leads existentes** |
| Campos nativos | Lista unificada — nativos e customizados juntos, ordenáveis |
| Permissão de configurar | `GERENTE` e `SUPER_ADMIN` (mantém o atual) |
| Onde fica o editor | **Só dentro do painel do lead**, aba "Configurações". A aba `Campos` de `/settings` é removida |

### Interpretação de "não mexer nos leads já existentes"

Lida como duas garantias, ambas verificáveis:

1. **Nenhuma DDL na tabela `Lead`.** Nenhum `ALTER TABLE "Lead"` no SQL final. As entidades novas se ligam ao Lead por `LeadContact`, uma tabela nova cujo FK aponta *para* o Lead. Em Prisma, a linha `lead_contacts LeadContact[]` dentro de `model Lead` é uma relação virtual e **não gera DDL** — precisa estar no schema, mas não altera a tabela.
2. **Nenhum backfill, nenhum UPDATE em massa.** Os leads existentes ganham zero linha em `Contact`/`Company`/`LeadContact`. No painel, o bloco Contato aparece vazio com um botão "Vincular contato". `Lead.empresa` e `Lead.cargo` continuam existindo e visíveis como campos nativos de escopo LEAD — os dados legados não somem nem migram.

### Estado real do banco (medido em 05/08/2026, via REST)

| Tabela | Linhas |
| --- | --- |
| `Lead` | **7.525** |
| `Tenant` | **37** |
| `CustomFieldDef` | **1** |
| `Contact` / `Company` / `LeadContact` | não existem (404) |

> ⚠️ Planos anteriores falavam em "691 leads" — número **desatualizado**. São 7.525.
> Confirma por que a regra de não tocar em `Lead` vale a pena: qualquer `ALTER`
> com rewrite nessa tabela seria caro e arriscado em produção.
>
> Os **37 tenants** são o dimensionamento real do bootstrap da Tarefa 3: ele roda
> por tenant, sob demanda, e cria 3 grupos + 17 defs nativos em cada um. Nada de
> job global.
>
> A **única** linha de `CustomFieldDef` existente é exatamente o caso de "def
> órfão" que o bootstrap precisa adotar (`group_id` nulo → grupo Principal de
> LEAD). Cenário real, não hipotético.

> ⚠️ **Duplicação consciente:** depois desta entrega existirão dois lugares para "empresa" — `Lead.empresa` (legado, campo nativo LEAD) e a entidade `Company`. Isso é o preço de não migrar os leads existentes. O tenant que adotar `Company` pode esconder o campo legado (`visible: false`) sem perder o dado. Uma consolidação futura seria um plano à parte, com backfill explícito.

---

## Global Constraints

- **Proibido `any`** em código de produção (regra 2 do CLAUDE.md). Em `.spec.ts` o repositório libera com `/* eslint-disable @typescript-eslint/no-explicit-any */` no topo — seguir esse padrão.
- **Migration é manual e cirúrgica.** O `_prisma_migrations` do Supabase `dzjjpuwqhphgcevjvvbh` está poluído (~121 linhas, ~47 *unfinished*). **NUNCA** rodar `prisma migrate deploy` nem `prisma db push`. Procedimento obrigatório na Tarefa 1.
- `npx prisma` quebra pelo hook rtk (PATH) — chamar via `node ../../node_modules/prisma/build/index.js ...`.
- Testes da API: `cd apps/api && npx jest --verbose` (Jest v30 — `-v` é `--version`). **Baseline medido no início: 20 suites / 192 testes.** Nenhuma tarefa pode reduzir isso.
- **Antes de rodar qualquer teste em clone novo:** `prisma generate`. Sem o client gerado, 13 das 21 suites quebram com `TS7006: Parameter 'tx' implicitly has an 'any' type` — parece erro de código e não é. O comando aceita `DATABASE_URL` de mentira (`postgresql://x:x@localhost:5432/x`), porque `generate` não conecta.
- `apps/web` precisa continuar compilando: `cd apps/web && npx tsc --noEmit`. É esse build que a Vercel publica.
- O runner de testes do `apps/web` cobre apenas `src/lib/**/*.spec.ts` (`apps/web/jest.config.js`). Lógica pura nova do frontend vai em `src/lib/` para ser testável; componentes são verificados por `tsc --noEmit` + `eslint`.
- **Isolamento por tenant é inegociável.** Toda query nova filtra por `tenant_id` vindo do `AuthUser`. Nunca aceitar `tenant_id` do body.
- Toda entrada validada com Zod (regra 7).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `apps/api/prisma/schema.prisma` (modificar) | Novos modelos + campos em `CustomFieldDef` |
| `apps/api/prisma/manual-migrations/20260805_kommo_fields.sql` (novo) | DDL revisada à mão |
| `apps/api/src/modules/leads/field-schema.ts` (novo) | Catálogo dos campos nativos e tipos. Função pura, sem Prisma |
| `apps/api/src/modules/leads/field-schema.spec.ts` (novo) | Testes do catálogo e da coerção de valores |
| `apps/api/src/modules/leads/custom-fields.service.ts` (modificar) | Bootstrap dos nativos, CRUD por escopo, reorder |
| `apps/api/src/modules/leads/custom-fields.controller.ts` (modificar) | Rotas de grupo e reorder |
| `apps/api/src/modules/leads/custom-fields-bootstrap.spec.ts` (novo) | Prova idempotência e isolamento por tenant |
| `apps/api/src/modules/contacts/` (novo módulo) | `Contact` + `Company` + vínculo com Lead |
| `apps/api/src/modules/contacts/contacts.service.spec.ts` (novo) | Escopo de tenant e vínculo |
| `apps/web/src/lib/field-render.ts` (novo) | Lógica pura: agrupar defs, coagir valor, montar payload |
| `apps/web/src/lib/field-render.spec.ts` (novo) | Testes do acima (único runner do web) |
| `apps/web/src/components/fields/field-input.tsx` (novo) | Renderiza um def como input, por tipo |
| `apps/web/src/components/fields/field-group-list.tsx` (novo) | Lista de grupos + campos, modo leitura |
| `apps/web/src/components/fields/field-editor.tsx` (novo) | Aba "Configurações" — CRUD + drag-and-drop |
| `apps/web/src/components/kanban/lead-detail-drawer.tsx` (modificar) | Vira abas; delega os campos aos componentes acima |
| `apps/web/src/components/chat/lead-details-sheet.tsx` (modificar) | Passa a renderizar o mesmo schema |
| `apps/web/src/app/(dashboard)/settings/page.tsx` (modificar) | Remove a aba `Campos` |
| `apps/web/src/app/(dashboard)/settings/components/CustomFieldsTab.tsx` (deletar) | Substituído pelo `field-editor` |

---

## Fase 1 — Banco e catálogo

### Task 1: Migration manual

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/manual-migrations/20260805_kommo_fields.sql`

**Schema a escrever:**

```prisma
enum FieldScope {
  LEAD
  CONTATO
  EMPRESA
}

model CustomFieldGroup {
  id         String     @id @default(uuid())
  tenant_id  String
  escopo     FieldScope
  nome       String
  ordem      Int        @default(0)
  is_system  Boolean    @default(false)
  created_at DateTime   @default(now())

  fields CustomFieldDef[]

  @@unique([tenant_id, escopo, nome])
  @@index([tenant_id, escopo, ordem])
}
```

Em `CustomFieldDef`, adicionar:

```prisma
  escopo     FieldScope        @default(LEAD)
  group_id   String?
  group      CustomFieldGroup? @relation(fields: [group_id], references: [id], onDelete: SetNull)
  native_key String?
  api_only   Boolean           @default(false)
  visible    Boolean           @default(true)
```

e **trocar** `@@unique([tenant_id, key])` por `@@unique([tenant_id, escopo, key])`.

`Contact`, `Company` e `LeadContact` conforme a seção Architecture: `Contact` com `nome/telefone/email/cargo/company_id/dados_custom`, `Company` com `nome/telefone/email/site/endereco/dados_custom`, `LeadContact` com `@@id([lead_id, contact_id])` e `is_principal`. Ambas com `tenant_id` + índice.

Em `model Lead` adicionar **apenas** `lead_contacts LeadContact[]`. Em `model Tenant` adicionar `contacts Contact[]`, `companies Company[]`, `custom_field_groups CustomFieldGroup[]`.

**Procedimento — executado com um desvio deliberado:**

O plano original mandava `migrate diff --from-schema-datasource`, que lê o estado
real do banco e por isso exige credenciais **e** traz o drift junto, obrigando a
uma limpeza manual arriscada. Trocado por **diff schema-contra-schema**:

```
node ../../node_modules/prisma/build/index.js migrate diff \
  --from-schema-datamodel <cópia do schema antes das alterações> \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Esse modo não abre conexão e não enxerga o drift, então o SQL já sai contendo
**só** as adições — sem etapa de "apagar o que não deveria estar aqui", que era
o ponto mais frágil do procedimento antigo. Efeito colateral bem-vindo: o script
roda sem as credenciais do banco à mão.

O SQL final foi reescrito à mão em cima da saída, com guardas idempotentes
(`IF NOT EXISTS` / `DO $$ ... $$`) no estilo de `20260710_custom_fields.sql`, e
envolvido em `BEGIN; ... COMMIT;`.

**Gate de segurança (corrigido):**

```
sed 's/--.*//' 20260805_kommo_fields.sql | grep -c 'ALTER TABLE "Lead"'
```

O `sed` é obrigatório: sem tirar os comentários, a própria linha que documenta o
gate conta como ocorrência e o teste dá falso positivo. Resultado atual: **0**.
Tabelas efetivamente alteradas: `Company`, `Contact`, `CustomFieldDef`,
`CustomFieldGroup`, `LeadContact`.

**Falta fazer (exige acesso ao banco, não disponível na sessão):** aplicar o SQL
no Supabase, rodar `migrate resolve --applied 20260805_kommo_fields`, e conferir
os `SELECT count(*)` listados no rodapé do arquivo.

**Efeito colateral já tratado:** o unique de `CustomFieldDef` virou
`(tenant_id, escopo, key)`, o que renomeou o argumento do `findUnique` no
serviço. Corrigido em `custom-fields.service.ts` com `escopo: 'LEAD'` fixo —
comportamento idêntico ao de hoje; a criação por escopo entra na Tarefa 3.

- [x] Task 1 concluída (schema + SQL revisado; **aplicação no banco pendente**)

---

### Task 2: Catálogo de campos nativos (função pura)

**Files:**
- Create: `apps/api/src/modules/leads/field-schema.ts`
- Test: `apps/api/src/modules/leads/field-schema.spec.ts`

**Produces:**

```ts
export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'date',
  'select', 'multiselect', 'boolean', 'url', 'phone', 'email',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface NativeFieldSpec {
  native_key: string;
  nome: string;
  tipo: FieldType;
  ordem: number;
  api_only: boolean;
  /** false = não pode ser escondido nem desativado (quebra o CRM). */
  removable: boolean;
  options?: string[];
}

export const NATIVE_FIELDS: Record<FieldScope, NativeFieldSpec[]>;
export function coerceValue(tipo: FieldType, raw: unknown): unknown; // lança em tipo inválido
```

**Nativos por escopo:**

- **LEAD** — `nome` (text, `removable:false`), `telefone` (phone, `removable:false`), `email` (email), `valor_estimado` (currency), `temperatura` (select, opções `FRIO/MORNO/QUENTE/MUITO_QUENTE`, `removable:false`), `empresa` (text), `cargo` (text), `proximo_followup` (date, `api_only:true`)
- **CONTATO** — `nome` (text, `removable:false`), `telefone` (phone), `email` (email), `cargo` (text)
- **EMPRESA** — `nome` (text, `removable:false`), `telefone` (phone), `email` (email), `site` (url), `endereco` (textarea)

`removable:false` é o que impede a empresa de se dar um tiro no pé: esconder `Lead.telefone` quebraria envio de WhatsApp e dedupe.

**Contexto:** `coerceValue` centraliza a conversão string→tipo. `currency` aceita `"1.234,56"` e devolve `number`. `multiselect` devolve `string[]`. `phone`/`url`/`email` são `string` com validação de formato (não normalizar telefone aqui — o CRM já tem essa lógica no ingest).

**Ajustes feitos durante a execução:**
- `coerceValue` ganhou um 3º parâmetro opcional `options`, para a validação de
  `select`/`multiselect` morar junto da coerção em vez de espalhada no serviço.
- Adicionado `FIELD_SCOPES`/`FieldScope` aqui (espelhando o enum do Prisma, no
  mesmo padrão de `common/types/roles.ts`), para o módulo continuar utilizável
  sem importar o client gerado.
- `date` valida mas **não** converte: passar a gravar ISO completo mudaria o
  significado dos valores `YYYY-MM-DD` já existentes em `dados_custom`.
- O `default` do switch usa `const exhaustive: never` — tipo novo em
  `FIELD_TYPES` sem `case` correspondente quebra o build em vez de passar batido.

**Verificação:** 46 testes, todos passando. Suíte da API foi de 20 suites/192
testes para **21 suites/238 testes**. `tsc --noEmit` e `eslint` limpos.

- [x] Task 2 concluída

---

## Fase 2 — Backend

### Task 3: Bootstrap e CRUD por escopo

**Files:**
- Modify: `apps/api/src/modules/leads/custom-fields.service.ts`
- Test: `apps/api/src/modules/leads/custom-fields-bootstrap.spec.ts`

**`ensureBootstrap(tenantId)`** — roda dentro de `list()`, idempotente, em transação:
- Se o tenant não tem `CustomFieldGroup`, cria um grupo `is_system: true` chamado "Principal" para cada um dos 3 escopos.
- Cria os defs nativos de `NATIVE_FIELDS` com `createMany({ skipDuplicates: true })`.
- **Migração dos defs órfãos:** defs que já existem (tenants antigos) têm `group_id: null` e `escopo: LEAD` pelo default — o bootstrap os atrela ao grupo Principal de LEAD, preservando `ordem`.
- Nunca cria campo de negócio. Tenant novo = só nativos.

**`list(user)`** → `{ groups: CustomFieldGroup[], fields: CustomFieldDef[] }` de todos os escopos, ordenado por `(escopo, group.ordem, field.ordem, created_at)`.

**`create`** ganha `escopo` e `group_id` (validar que o grupo é do mesmo tenant **e** do mesmo escopo). `update` passa a aceitar `visible`, `api_only`, `group_id`, `options`. `tipo` continua imutável.

**`deactivate`** — se o def tem `native_key`, **recusar** com `BadRequestException`; nativo só pode ser escondido via `visible: false`, e apenas se `removable !== false`.

**`reorder(items, user)`** — `[{ id, group_id, ordem }]`, uma transação, todos os ids validados contra o tenant antes de escrever.

**`validateValues(values, tenantId, escopo)`** — ganha o parâmetro `escopo` e passa a usar `coerceValue`. Chave desconhecida continua rejeitada. Campo `api_only` só aceita escrita quando a chamada vem da API pública (novo parâmetro `fromPublicApi = false`).

**Testes obrigatórios:** bootstrap roda duas vezes sem duplicar; tenant A não vê campo do tenant B; nativo não pode ser desativado; `removable:false` não pode ser escondido; def com `group_id` de outro escopo é rejeitado.

**Decisões tomadas na execução:**
- **`GET /custom-fields` manteve o formato antigo** (array de campos customizados
  do lead) e o schema completo foi pra `GET /custom-fields/schema`. Trocar o
  retorno da rota existente quebraria a UI atual em runtime sem o `tsc` acusar
  (axios devolve `any`), deixando a branch com um intervalo quebrado à toa.
- **Colisão de key nativo × customizado resolvida sem perda:** se o tenant já tem
  um campo com a key de um nativo, o nativo entra com `key` sufixada
  (`nome__nativo`). `native_key` é que aponta pra coluna, então os dois convivem.
  Promover o campo do tenant a nativo teria órfãos valores em `dados_custom`.
- **`validateValues` recusa key de campo nativo** dentro de `dados_custom` —
  aceitar criaria uma cópia no Json que sombrearia a coluna real na leitura.
- **Campos adotados no bootstrap ganham `ordem + 100`**, senão ficariam
  intercalados com os nativos (que ocupam 0..N e os antigos estão todos em 0).

**Verificação:** 22 testes. Suíte: 22 suites / 260 testes.

- [x] Task 3 concluída

---

### Task 4: Rotas de grupo e reorder

**Files:**
- Modify: `apps/api/src/modules/leads/custom-fields.controller.ts`

| Método | Rota | Papel |
| --- | --- | --- |
| GET | `/api/custom-fields` | qualquer autenticado |
| POST/PATCH/DELETE | `/api/custom-fields[/:id]` | `GERENTE` |
| POST | `/api/custom-fields/reorder` | `GERENTE` |
| POST/PATCH/DELETE | `/api/custom-field-groups[/:id]` | `GERENTE` |

Deletar grupo: campos vão para o grupo Principal do mesmo escopo (`onDelete: SetNull` + realocação no serviço). Grupo `is_system` não pode ser deletado.

**Detalhe de roteamento:** `@Post('reorder')` tem de ser declarado **antes** de
`@Patch(':id')`/`@Delete(':id')` no controller. O Nest casa rotas na ordem de
declaração, e `reorder` seria capturado como um `:id`.

- [x] Task 4 concluída

---

### Task 5: Módulo Contacts/Companies

**Files:**
- Create: `apps/api/src/modules/contacts/{contacts.module,contacts.service,contacts.controller,companies.service,companies.controller}.ts`
- Test: `apps/api/src/modules/contacts/contacts.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`

CRUD dos dois, sempre filtrado por `tenant_id`. `dados_custom` validado com `validateValues(..., 'CONTATO' | 'EMPRESA')`.

Vínculo: `POST /api/leads/:id/contacts` (body `{ contact_id, is_principal? }`), `DELETE /api/leads/:id/contacts/:contactId`. Ambos checam que lead e contato são do mesmo tenant. Só um `is_principal` por lead (a transação rebaixa o anterior).

`GET /api/leads/:id` passa a incluir `lead_contacts: { contact: { company: true } }`.

**Teste obrigatório:** vincular contato de outro tenant retorna 404, não 200.

**Executado.** Papéis: `OPERADOR` cria/edita/vincula, `GERENTE` apaga. A suíte
inclui três testes que travam a garantia central do plano — `lead.update` e
`lead.updateMany` **nunca** são chamados ao vincular, desvincular ou apagar
contato. Se alguém no futuro fizer o vínculo escrever no lead, esses testes caem.

**Detalhe de tipagem:** `Prisma.InputJsonObject` é obrigatório no `create` —
`Record<string, unknown>` não é atribuível ao campo Json e a regra "sem `any`"
impede o atalho. O `update` não precisa porque passa o objeto inteiro.

**Verificação:** 13 testes. Suíte: 23 suites / 273 testes. ESLint sem erros.

- [x] Task 5 concluída

---

## Fase 3 — Frontend

### Task 6: Lógica pura de renderização

**Files:**
- Create: `apps/web/src/lib/field-render.ts`
- Test: `apps/web/src/lib/field-render.spec.ts`

```ts
export function groupFields(schema: FieldSchema, escopo: FieldScope): GroupWithFields[];
export function readValue(def: FieldDef, record: Record<string, unknown>): unknown;
export function buildPayload(defs: FieldDef[], values: Record<string, unknown>):
  { native: Record<string, unknown>; custom: Record<string, unknown> };
```

`readValue` é o coração da lista unificada: se `def.native_key` existe, lê da coluna (`record[def.native_key]`); senão lê de `record.dados_custom[def.key]`. `buildPayload` faz o caminho inverso, separando o que vai para colunas do que vai para o Json — é o que permite nativo e customizado conviverem na mesma lista.

Este é o único código de frontend com teste unitário. Cobrir: nativo vs custom, campo invisível fora do payload, `api_only` nunca no payload.

- [ ] Task 6 concluída

---

### Task 7: Componentes de campo

**Files:**
- Create: `apps/web/src/components/fields/field-input.tsx`, `field-group-list.tsx`

`FieldInput` — um `switch` sobre `def.tipo` cobrindo os 11 tipos. `api_only` renderiza `disabled` com o badge "Apenas API" (igual ao print do Kommo). `multiselect` usa `Popover` + checkboxes (não há componente multi-select no repo).

`FieldGroupList` — recebe escopo e registro, renderiza grupos como seções com os campos dentro, respeitando `visible` e `ordem`.

- [ ] Task 7 concluída

---

### Task 8: Editor (aba Configurações)

**Files:**
- Create: `apps/web/src/components/fields/field-editor.tsx`
- Delete: `apps/web/src/app/(dashboard)/settings/components/CustomFieldsTab.tsx`
- Modify: `apps/web/src/app/(dashboard)/settings/page.tsx` (remover a aba `Campos` e o import)

Réplica do print: abas de grupo no topo com `+` para criar grupo; lista de campos com handle `⠿` (`@dnd-kit/sortable`, mesmo padrão do Kanban); os três blocos "Campos do lead" / "Campo do contato" / "Campos da empresa"; "Adicionar campo" ao fim de cada bloco.

Renomear grava só `nome` — a `key` **não** muda, então nenhum valor já gravado se perde. Drop dispara `POST /custom-fields/reorder`. Visível só para `GERENTE`/`SUPER_ADMIN`.

- [ ] Task 8 concluída

---

### Task 9: Painéis de lead com abas

**Files:**
- Modify: `apps/web/src/components/kanban/lead-detail-drawer.tsx`
- Modify: `apps/web/src/components/chat/lead-details-sheet.tsx`

Abas via Radix `Tabs`:
- **Principal** — `FieldGroupList` escopo LEAD + bloco Contato (com "Vincular contato" quando vazio) + bloco Empresa. Substitui as seções hardcoded "Contato" e "Qualificação" ([lead-detail-drawer.tsx:392-549](../../apps/web/src/components/kanban/lead-detail-drawer.tsx)).
- **Estatísticas** — `ActivityTimeline` (já existe).
- **Mídia** — mídias da conversa reaproveitando `media-image`/`video-bubble`. Se o endpoint de listagem não existir, entregar vazio com aviso e abrir tarefa separada; **não** inventar endpoint.
- **Configurações** — `FieldEditor`, só para `GERENTE`+.

A `lead-details-sheet` do chat hoje não renderiza campo customizado nenhum — passa a usar os mesmos componentes. Preservar o autosave/`mark()` e o botão Desfazer que já existem no drawer do Kanban.

- [ ] Task 9 concluída

---

## Verificação final

- [ ] `cd apps/api && npx jest --verbose` — ≥ 20 suites, todas verdes
- [ ] `cd apps/web && npx tsc --noEmit` — limpo
- [ ] `npm run lint` — limpo, zero `any` em produção
- [ ] `grep -i 'ALTER TABLE "Lead"' apps/api/prisma/manual-migrations/20260805_kommo_fields.sql` — vazio
- [ ] `SELECT count(*) FROM "Lead"` idêntico ao de antes da migration
- [ ] Tenant novo: painel abre com só os nativos, nenhum campo de negócio
- [ ] Criar campo no tenant A não aparece no tenant B
- [ ] Renomear campo preenchido não perde valor
- [ ] Lead antigo (pré-migration) abre normalmente, bloco Contato vazio
