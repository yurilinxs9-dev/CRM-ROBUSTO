# Twenty CRM — Referência técnica para o CRM-ROBUSTO

> **Data da pesquisa:** 24/08/2026
> **Objeto:** twentyhq/twenty (twenty.com), estado atual — linha 2.x (2.26.0, jul/2026)
> **Objetivo:** entender *conceitualmente* como o Twenty resolve 6 padrões de UX/arquitetura que
> estão no nosso backlog, para reimplementarmos melhor, no nosso stack, sem tocar no código deles.

---

## Aviso legal (ler antes de usar este documento)

O núcleo do Twenty (`twenty-server`, `twenty-front`) é **AGPL-3.0**. Este documento foi produzido
lendo documentação pública, release notes, listagens de diretório e descrições de PRs, e **descreve
conceitos com palavras próprias**. Nenhum trecho de código-fonte, arquivo ou texto literal de
arquivo AGPL foi copiado para cá.

Regras para quem for implementar a partir daqui:

- **Pode:** copiar *ideias*, nomes de conceitos de domínio (view, view field, step, trigger),
  formatos de API descritos abstratamente, decisões de UX.
- **Não pode:** abrir um arquivo do `twenty-server`/`twenty-front` e traduzir/adaptar linha a linha.
  Isso contamina o nosso repositório proprietário com AGPL.
- **Zona segura:** o pacote `twenty-ui` e o app toolkit/SDK são **MIT**. Dá para olhar código lá.
  Mas atenção ao descasamento de stack: eles usam **Linaria (CSS-in-JS zero-runtime) + Recoil/Jotai**;
  nós usamos **Tailwind + shadcn/ui + TanStack Query + Zustand**. Copiar componente de lá quase
  sempre custa mais do que reescrever com shadcn.
- Todo snippet de código deste documento é **nosso**, escrito para o nosso stack. Não veio de lá.

---

## 0. Contexto: o stack deles vs o nosso

| Camada | Twenty (2026) | CRM-ROBUSTO |
|---|---|---|
| Backend | NestJS + TypeORM + GraphQL Yoga | NestJS + Prisma + REST |
| Banco | Postgres, **1 schema por workspace**, DDL gerado em runtime | Postgres (Supabase), schema único, `tenant_id` em toda tabela |
| Modelo de dados | **Metadata-driven**: objetos/campos são linhas em tabelas de metadados; o GraphQL é gerado e cacheado por workspace | Modelo fixo em Prisma + `CustomFieldDef`/`CustomFieldGroup` + `Lead.custom_fields` (Json) |
| Filas | BullMQ + Redis | BullMQ + Redis (mesmo) |
| Front | React 19 SPA (Vite), Apollo Client, Recoil **e** Jotai, Linaria | Next.js 14 App Router, TanStack Query, Zustand, Tailwind/shadcn |
| Realtime | SSE (`sse-db-event`) para live updates | Socket.IO |
| i18n | Lingui, 28+ idiomas | pt-BR fixo |

**A diferença estrutural que manda em tudo:** o Twenty é um *motor de CRM genérico*. Cada tela é
uma função pura de metadados (objeto → campos → view → layout). Nós somos um *CRM de WhatsApp
multi-tenant vertical*: temos entidades fixas (Lead, Conversation, Message, Stage, Sector) e um
sistema de campos customizados por cima.

> **Consequência prática:** não devemos copiar o motor de metadados. Devemos copiar o **modelo de
> configuração de tela** (view / view field / filtro / ordenação / agregação) e amarrá-lo às nossas
> entidades fixas + `CustomFieldDef`. Isso nos dá 90% do valor com 10% da complexidade deles.

Já temos peças que encaixam bem:

- `CustomFieldGroup` + `CustomFieldDef` (com `native_key`, `ordem`, `visible`, `api_only`) ≈ o
  `fieldMetadata` deles, incluindo a ideia de nativo e customizado na mesma lista ordenável.
- `LeadActivity` (`tipo`, `dados_antes`, `dados_depois`) ≈ `timelineActivity` deles.
- `LeadView` (nome, `filtros` Json, `user_id` null = compartilhada) ≈ um `view` deles, **muito**
  simplificado — só filtros, sem colunas/ordenação/kanban.
- `command-palette.tsx` com `cmdk` ≈ o `command-menu` deles, na versão v0.
- `automation.service.ts` + `PIPELINE_AUTO_ACTIONS_QUEUE` ≈ um workflow engine embrionário.

---

# 1. Views salvas por usuário (colunas, filtros, ordenação — tabela + kanban)

## Como o Twenty faz

### Modelo de dados

Uma "view" no Twenty **não é um blob de configuração**. É um agregado normalizado, com uma tabela
por dimensão configurável. Conceitualmente:

- **View** — a entidade raiz. Guarda: objeto alvo (`objectMetadataId`), nome, ícone, **tipo**
  (`TABLE` | `KANBAN` | `CALENDAR` | `LIST`), posição na lista de views, `key` (marca a view padrão
  "All X" gerada pelo sistema — as demais têm key nula), **visibilidade** (workspace vs *unlisted*),
  e — para kanban — qual campo é usado como coluna (`kanbanFieldMetadataId`), mais dois campos
  introduzidos no PR de agregações: a **operação de agregação** escolhida e o **campo alvo** dessa
  agregação.
- **ViewField** — uma linha por campo do objeto **por view**. Guarda `fieldMetadataId`,
  `isVisible`, `position` (ordem da coluna) e `size` (largura em px). É isto que dá "colunas
  configuráveis": a mesma entidade responde por *quais colunas aparecem*, *em que ordem* e *com que
  largura*, e no kanban responde por *quais campos aparecem no card*.
- **ViewFilter** — uma linha por filtro: campo alvo, **operando** (`Is`, `IsNot`, `Contains`,
  `DoesNotContain`, `IsEmpty`, `IsNotEmpty`, `GreaterThan`, `LessThan`, `IsBefore`, `IsAfter`,
  `IsRelative`, `IsInPast`/`IsInFuture`…), valor serializado e o **display value** (o rótulo que o
  chip mostra, para não precisar refazer um join só para desenhar o chip).
- **ViewFilterGroup** — árvore de grupos com operador lógico (`AND` / `OR`) e referência ao grupo
  pai. É o que permite o "filtro avançado" com parênteses aninhados. Filtros simples ficam num
  grupo raiz implícito.
- **ViewSort** — campo + direção (`asc`/`desc`) + posição. Multi-sort: o primeiro é o primário, os
  seguintes desempatam. Desde mai/2026 dá para escolher **qual sub-campo** de um campo composto
  ordena (ex.: ordenar "Nome" por sobrenome, "Endereço" por cidade).
- **ViewGroup** — uma linha por valor do campo de agrupamento (ex.: uma por opção do select
  "Stage"). Guarda o valor, `isVisible` e `position`. É isto que permite **esconder uma coluna do
  kanban** e **reordenar colunas manualmente** (feature de jul/2026), sem tocar na definição do
  campo select. Também é usado no *table view com grouping* (seções colapsáveis).

Duas coisas importantes desse desenho:

1. **Colunas do kanban ≠ opções do select.** Um `ViewGroup` por view desacopla "ordem/visibilidade
   das colunas nesta view" de "opções que o campo aceita". Ganho enorme: cada vendedor pode
   esconder colunas que não usa sem mexer no pipeline do time.
2. **Nada é blob.** Filtro/sort/campo sendo linhas permite reordenar com drag&drop persistindo só
   uma coluna `position`, e permite consultas do tipo "quais views usam este campo?" antes de
   deletar um campo.

### UX

- **View bar** no topo: seletor de view (dropdown com as views do objeto), chips de filtro e chips
  de ordenação.
- **Estado sujo (dirty)**: ao mexer em filtro/sort/coluna de uma view salva, as mudanças ficam num
  estado "não salvo" **local**. A barra passa a mostrar `Salvar` / `Descartar` / `Salvar como nova
  view`. Isso é o detalhe de UX que mais importa: **filtrar não destrói a view do time**. O usuário
  explora à vontade e só persiste se quiser.
- **Visibilidade**: view *Workspace* (todo mundo vê) ou *Unlisted* (só o criador vê, mas o link
  direto abre para quem receber). As views padrão "All \<Objeto\>" não podem virar unlisted.
- **Favoritos**: qualquer view pode ser fixada na sidebar; favoritos são por usuário.
- **Reordenação** das views por drag&drop no dropdown.
- Configuração de campos fica num menu **Options** (olho para mostrar/esconder, arrastar para
  reordenar). Desde abr/2026 há **busca dentro do seletor de campos** — detalhe pequeno que salva
  a usabilidade quando o objeto tem 40 campos.
- Largura de coluna: arrastar a borda do header; persiste no `size` do ViewField.
- **Salvamento automático**: mudanças de campo/coluna salvam sozinhas; mudanças de filtro/sort é que
  entram no fluxo dirty.
- **Grouping em tabela**: seções colapsáveis por campo select, com ordenação dos grupos A→Z, Z→A ou
  manual, e possibilidade de esconder grupos. A doc deles recomenda **10–15 grupos visíveis no
  máximo** por performance — sinal claro de que cada grupo é uma query separada.
- Desde jul/2026 dá para **agrupar por campo de relação** (ex.: agrupar leads por responsável) e
  **filtrar através de relação** (ex.: pessoas cuja empresa contém "X").

### API (conceitual)

- Views são **dados normais do workspace**: têm CRUD via a mesma API GraphQL/REST dos outros
  objetos. Não existe endpoint especial "/views".
- A leitura de registros aceita `filter` (objeto aninhado com operadores e `and`/`or`), `orderBy`
  (lista de `campo[Direção]`, com variantes `AscNullsFirst`/`DescNullsLast`), `limit` (máx. 200) e
  paginação **por cursor** (`startingAfter` / `endingBefore` a partir de `pageInfo.endCursor`).
  Há também um parâmetro `depth` (0 ou 1) para trazer relações de primeiro nível.
- O front traduz `ViewFilter[] + ViewFilterGroup[]` no objeto `filter` da query, e
  `ViewSort[]` no `orderBy`. **A view não é enviada ao servidor como identidade** — ela é compilada
  em query no cliente. Isso é uma escolha deles ligada ao GraphQL; para nós, o oposto é melhor
  (ver adaptação).

## Como adaptar no CRM-ROBUSTO

Hoje temos `LeadView { nome, filtros Json, user_id }` e um whitelist de 11 chaves de filtro no
`lead-views.service.ts`. Funciona, mas: (a) não guarda colunas nem ordenação, (b) não tem tipo
(tabela/kanban), (c) o Json opaco impede saber quais views usam a tag que você quer apagar.

**Proposta: normalizar, mas sem exagero.** Manter uma tabela raiz + uma tabela de campos, e deixar
filtro/sort como Json *tipado e validado por Zod* (nós não temos filtro avançado com parênteses
ainda; normalizar isso agora é over-engineering).

### Prisma

```prisma
enum ViewType {
  TABLE
  KANBAN
}

enum ViewVisibility {
  PRIVATE     // só o criador
  WORKSPACE   // todo o tenant
}

model View {
  id            String         @id @default(uuid())
  tenant_id     String
  escopo        FieldScope     @default(LEAD)   // reaproveita LEAD/CONTATO/EMPRESA
  nome          String
  icone         String?
  tipo          ViewType       @default(TABLE)
  visibilidade  ViewVisibility @default(PRIVATE)
  /// Dono. Null = view de sistema (a "Todos os leads", não deletável).
  owner_id      String?
  is_system     Boolean        @default(false)
  ordem         Int            @default(0)

  /// KANBAN: por qual pipeline as colunas são montadas (default: pipeline ativo).
  pipeline_id   String?
  /// Filtros validados por Zod. Formato versionado: { v: 1, groups: [...] }.
  filtros       Json           @default("{}")
  /// [{ key: 'valor', dir: 'desc' }, ...] — multi-sort, ordem = prioridade.
  ordenacao     Json           @default("[]")

  created_at    DateTime       @default(now())
  updated_at    DateTime       @updatedAt

  tenant  Tenant      @relation(fields: [tenant_id], references: [id], onDelete: Cascade)
  owner   User?       @relation(fields: [owner_id], references: [id], onDelete: Cascade)
  fields  ViewField[]
  groups  ViewGroup[]

  @@index([tenant_id, escopo, visibilidade])
  @@index([tenant_id, owner_id])
}

/// Uma linha por campo exibido nesta view. Serve para tabela (coluna) e kanban (campo do card).
model ViewField {
  id        String  @id @default(uuid())
  view_id   String
  /// Chave do campo: `native_key` de um campo nativo OU `key` de um CustomFieldDef.
  field_key String
  visible   Boolean @default(true)
  ordem     Int     @default(0)
  /// Largura em px na tabela. Null = auto.
  largura   Int?
  /// Agregação exibida no rodapé da coluna (tabela) ou no header (kanban).
  agregacao AggregateOp?

  view View @relation(fields: [view_id], references: [id], onDelete: Cascade)

  @@unique([view_id, field_key])
  @@index([view_id, ordem])
}

/// Visibilidade/ordem das colunas do kanban NESTA view — desacoplado de Stage.ordem.
model ViewGroup {
  id       String  @id @default(uuid())
  view_id  String
  /// Valor do agrupamento: stage_id, ou o valor de um select customizado.
  valor    String
  visible  Boolean @default(true)
  ordem    Int     @default(0)

  view View @relation(fields: [view_id], references: [id], onDelete: Cascade)

  @@unique([view_id, valor])
  @@index([view_id, ordem])
}
```

> ⚠️ **Migração:** lembrar do estado poluído do `_prisma_migrations` (ver `CLAUDE.md`). Isto é
> criação de tabelas novas + FKs — gerar SQL com `prisma migrate diff`, limpar o drift alheio,
> aplicar em transação e registrar com `migrate resolve --applied`. Manter `LeadView` por 1 release
> e migrar os registros por script (`filtros` cai direto em `View.filtros` com `v:1`).

### NestJS

Manter REST (não vale trocar por GraphQL só por isso). Endpoints:

```
GET    /views?escopo=LEAD&tipo=KANBAN        → views visíveis ao usuário (dele + WORKSPACE)
POST   /views                                 → cria (body validado por Zod)
PATCH  /views/:id                             → renomear, trocar visibilidade, ícone
DELETE /views/:id                             → 403 se is_system
POST   /views/:id/duplicate                   → "salvar como nova view"
PUT    /views/:id/fields                      → substitui a lista inteira (ordem + visible + largura)
PUT    /views/:id/groups                      → idem para colunas do kanban
PATCH  /views/reorder                         → [{id, ordem}] em lote
```

**Decisão de arquitetura importante — e aqui divergimos do Twenty:** o Twenty compila a view em
query no cliente. Nós devemos **aceitar `view_id` no `GET /leads`** e compilar no servidor:

```
GET /leads?view_id=<uuid>&cursor=<...>&limit=50
GET /leads?view_id=<uuid>&override[temperatura]=QUENTE   // estado "sujo" sem salvar
```

Motivos: (1) o filtro fica auditável e testável num único lugar (`lead-filters.ts` do backend);
(2) evita que o cliente monte um `where` do Prisma; (3) o cache do TanStack Query fica com chave
curta e estável (`['leads', viewId, overrides]`); (4) permissão por setor/`lead-visibility.ts`
continua sendo aplicada num só ponto.

O compilador de view vira um serviço puro e testável:

```ts
// apps/api/src/modules/views/view-compiler.ts
export function compileView(view: ViewDefinition, user: AuthUser, overrides?: Partial<Filters>): {
  where: Prisma.LeadWhereInput;
  orderBy: Prisma.LeadOrderByWithRelationInput[];
};
```

### Front (Next.js + TanStack Query + Zustand)

- `useViews(escopo)` — TanStack Query, `staleTime` alto (views mudam pouco).
- **Estado sujo em Zustand**, não em URL: `useViewDraftStore` com `{ viewId, patch, isDirty }`.
  A URL guarda só `?view=<id>` (link compartilhável abre a view salva, não o rascunho do colega).
- `<ViewBar />` — `<ViewSwitcher />` (Popover shadcn) + `<FilterChips />` + `<SortChips />` +
  `<ViewDirtyActions />` (Salvar / Descartar / Salvar como nova).
- `<FieldsOptionsMenu />` — lista com `dnd-kit` (já é o padrão do nosso kanban), toggle de olho e
  **campo de busca** no topo (roubar essa do Twenty; com 30+ campos customizados vira obrigatório).
- Colunas redimensionáveis: `onPointerDown` no separador do header + `ResizeObserver`, persistindo
  com debounce de ~500 ms em `PUT /views/:id/fields`.
- Reaproveitar `lead-filters.ts` (já testado com Jest) como serializador do `patch`.

**Detalhes de UX que valem copiar tal e qual:**
- Mudança de coluna/largura salva sozinha; mudança de filtro/sort entra em dirty. É a distinção
  certa: layout é preferência, filtro é intenção.
- Ao clicar "Salvar como nova view", pré-preencher o nome com algo derivado do filtro
  ("Leads quentes sem tarefa") em vez de "Nova view".
- View de sistema não deletável e não renomeável, sempre no topo do dropdown.

## Esforço estimado

**G** (grande). É a fundação dos capítulos 4 e 5 e mexe em rota de listagem, cache do front e
migração de dados. Quebrar em: (1) tabelas + CRUD + migração do `LeadView` [M]; (2) compilador de
view no `GET /leads` [M]; (3) ViewBar + estado sujo [M]; (4) colunas configuráveis na tabela [M];
(5) ViewGroup no kanban [P].

---

# 2. Command palette (Ctrl+K)

## Como o Twenty faz

### O que é pesquisável

O ⌘K do Twenty não é um "buscador de páginas". É a **superfície universal de ação**. Ele mistura,
numa lista única com seções:

1. **Registros** — busca full-text global em todos os objetos (pessoas, empresas, oportunidades,
   notas, tarefas, objetos customizados). O backend tem um módulo `search` dedicado; a busca é
   Postgres full-text (coluna `tsvector` mantida por objeto, alimentada pelos campos marcados como
   pesquisáveis) — não é `ILIKE` em cima de N colunas.
2. **Navegação** — objetos, views, páginas de configuração, favoritos.
3. **Ações** — criar registro, importar/exportar CSV, exportar view, deletar registro, adicionar a
   favoritos, abrir a lista de atalhos de teclado, editar layout da página.
4. **Workflows manuais** — todo workflow com trigger manual aparece como comando. Se o trigger for
   *Single*/*Bulk*, ele só aparece no contexto certo (na página do objeto, com registros
   selecionados).
5. **Comandos de apps** — o SDK deixa um app declarar um item de menu com `label`, ícone,
   componente a abrir, `isPinned` (vira botão de ação rápida no canto superior direito) e
   **`conditionalAvailabilityExpression`** — uma expressão tipada sobre variáveis de contexto
   (`pageType`, `numberOfSelectedRecords`, `objectPermissions`) com operadores como `everyEquals`,
   `includes`, `isDefined`.

### Ranqueamento e contexto

O ponto forte deles é o **⌘K contextual**: a lista de ações muda conforme onde você está e o que
está selecionado. Há um `context-store` no front que carrega "objeto atual + registros
selecionados + tipo de página", e cada ação declara sua disponibilidade contra esse contexto.

Ordenação, na prática: ações contextuais primeiro (o que faz sentido *agora*), depois navegação,
depois resultados de registros por relevância do full-text, tudo agrupado em seções nomeadas. Não
há um scorer único global — é **seções com prioridade fixa + ranking dentro da seção**. Isso é
deliberado: um scorer global faz a lista "pular" a cada tecla e destrói a memória muscular.

### Navegação interna (o detalhe que quase ninguém copia)

O command menu deles é uma **pilha de páginas**, não um popover plano. Você abre com ⌘K, digita,
seleciona um registro e ele **abre o registro dentro do próprio menu** (side panel), com botão de
voltar. Em jul/2026 adicionaram *preview* de registro navegando pelos resultados — dá para ver os
campos principais antes de abrir. O painel lateral, desde dez/2025, abre **ao lado** do conteúdo,
não por cima.

Teclado: ⌘K abre; `/` foca a busca; setas navegam; Enter executa; Esc volta uma página da pilha (e
só fecha na raiz). Existe uma tela de atalhos acessível pelo próprio menu, e o front tem um módulo
de *hotkey scope* que garante que as setas pertencem ao menu enquanto ele está aberto e voltam para
a tabela quando fecha.

### API (conceitual)

Uma query de busca global recebendo o termo, um limite, e opcionalmente a lista de tipos de objeto
a incluir; devolvendo itens heterogêneos com `{ tipo, id, rótulo, subtítulo, ícone/avatar, score }`.
As ações não vêm do servidor — são declaradas no cliente (exceto as de apps, que vêm do metadata).

## Como adaptar no CRM-ROBUSTO

Já temos `apps/web/src/components/command-palette.tsx` (140 linhas, `cmdk`): busca leads + navegação
fixa. O caminho é evoluir, não reescrever.

### Backend

**Busca global com Postgres FTS, não `ILIKE`.** Adicionar uma coluna gerada de busca por entidade
pesquisável:

```sql
-- Lead
ALTER TABLE "Lead" ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('portuguese',
      coalesce(nome,'') || ' ' || coalesce(telefone,'') || ' ' || coalesce(email,''))
  ) STORED;
CREATE INDEX lead_search_idx ON "Lead" USING GIN (search_vector);
```

Prisma não gera coluna `GENERATED` — declarar como `Unsupported("tsvector")?` e criar via SQL na
migração. Consultar com `$queryRaw` usando `websearch_to_tsquery('portuguese', $1)` e
`ts_rank_cd`. Para telefone, normalizar (só dígitos) numa coluna auxiliar — `tsvector` não ajuda em
busca parcial de número; ali é `LIKE '%digitos%'` com índice `pg_trgm`.

```
GET /search?q=<termo>&limit=8&types=lead,contact,company,conversation
→ { results: [{ type, id, label, sublabel, avatarUrl, score }] }
```

Rankear com `ts_rank_cd` por tipo e depois intercalar com pesos fixos por tipo
(lead 1.0, contato 0.8, empresa 0.6). Sempre filtrar por `tenant_id` **e** pelas regras de
`lead-visibility.ts` — busca global é o vazamento de dados mais fácil de introduzir num CRM
multi-tenant.

### Front

```tsx
// apps/web/src/components/command-palette/types.ts
export type CommandKind = 'navigate' | 'action' | 'record' | 'view' | 'workflow';

export interface CommandItem {
  id: string;
  kind: CommandKind;
  label: string;
  sublabel?: string;
  icon: LucideIcon;
  section: string;              // rótulo da seção (ordem definida por SECTION_ORDER)
  keywords?: string[];          // sinônimos pt-BR: "cliente" acha "lead"
  shortcut?: string;
  /** Disponibilidade contextual — a ideia boa do Twenty. */
  available?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  route: string;
  leadId?: string;
  selectedLeadIds: string[];
  conversationId?: string;
  user: AuthUser;
}
```

- `CommandContext` sai de um **store Zustand** (`useCommandContextStore`) que as telas alimentam:
  o kanban publica `selectedLeadIds`, o chat publica `conversationId`, a ficha publica `leadId`.
  É o `context-store` deles, na nossa escala.
- Seções com ordem fixa: `Ações` → `Ir para` → `Leads` → `Conversas` → `Views`. Dentro de `Leads`,
  ordem por score do backend. `shouldFilter={false}` no `cmdk` quando há query servidor.
- **Pilha de páginas**: `const [pages, setPages] = useState<CmdPage[]>([])`. `Backspace` com input
  vazio ou `Esc` faz `pop`. Páginas úteis desde o dia 1: raiz, "Mover para estágio…", "Atribuir
  a…", "Adicionar tag…", "Resposta rápida…". Isso substitui 4 dialogs.
- Debounce de 200 ms na busca; `keepPreviousData: true` no TanStack Query para a lista não piscar.
- Ações em massa: quando `selectedLeadIds.length > 0`, o topo da lista vira
  "N leads selecionados" e as ações passam a operar em lote (já temos `POST /leads/bulk/*`).
- **Não copiar:** o preview de registro dentro do menu. Bonito, mas é o item de menor
  retorno; o nosso `lead-detail-drawer` já resolve.

## Esforço estimado

**M** (médio). A busca FTS é [P/M] e o refactor do palette em itens declarativos + pilha de páginas
é [M]. O maior risco é o `GENERATED ALWAYS` na migração, dado o estado do `_prisma_migrations`.

---

# 3. Página unificada do registro (timeline, abas, edição inline, grupos de campos)

## Como o Twenty faz

### Modelo de dados

**Layout da página é dado, não código.** Existe um trio de entidades:

- **PageLayout** — o layout de um tipo de página (`RECORD_PAGE`, `RECORD_INDEX`, `DASHBOARD`,
  `STANDALONE_PAGE`), ligado a um objeto.
- **PageLayoutTab** — as abas, com nome, ícone, posição e o modo de layout
  (`VERTICAL_LIST` para páginas de registro, `GRID` para dashboards).
- **PageLayoutWidget** — os blocos dentro da aba, com posição/tamanho em grid e configuração
  própria. Tipos de widget disponíveis hoje: **Fields** (grupo de campos), **Related records**
  (lista/tabela/kanban/calendário de registros relacionados — isto chegou entre jun e jul/2026),
  **Emails**, **Calendar**, **Timeline**, **Tasks**, **Notes**, **Files**, **Charts**, **iFrame**,
  **Rich text** (editável inline, salva sozinho).

O usuário edita isso por **drag & drop** (Settings → Data Model → Layout, ou pelo ⌘K), e o layout
vale para **todos os registros daquele objeto** — é configuração do workspace, não do usuário.
Desde jul/2026 dá para arrastar widgets **entre abas**, inclusive para abas vazias.

**Timeline** é uma entidade própria (`timelineActivity`), com: nome do evento, `happensAt`, autor
(workspace member), o registro alvo, e um payload com o **diff** do que mudou. O SDK expõe
"timeline activity types" com um vocabulário padrão (`created`, `updated`, `deleted`, `restored`,
`linked`, `unlinked`) e dois modos: **emit automático** (o servidor cria o evento sozinho quando o
tipo declara `emit`) ou **explícito** (a lógica da app dispara). Detalhe forte: eventos podem
**fazer fan-out para registros relacionados** — uma nota criada em "Pessoa" aparece também na
timeline da "Empresa" dela, via a relação de junção. E o rendering de um evento customizado só
monta o componente **quando a linha é expandida** (nada de montar N sandboxes para eventos
visíveis).

Notas e tarefas não têm FK direta para o registro: usam tabelas de junção (`noteTarget`,
`taskTarget`), o que permite a mesma nota estar ligada a pessoa + empresa + oportunidade.

### UX

- Cabeçalho com o campo de exibição principal (editável inline), avatar/logo, chips de ação rápida
  (inclusive workflows manuais fixados) e botões.
- Coluna esquerda = campos; direita = abas de atividade. As abas típicas: Timeline, Tarefas, Notas,
  E-mails, Calendário, Arquivos.
- **Campos são grupos** (widget Fields), então dá para ter "Overview" com 6 campos essenciais e uma
  aba "Detalhes" com os outros 30. Isso é exatamente o nosso `CustomFieldGroup`.
- **Tudo editável inline**, com o mesmo componente da célula da tabela (ver capítulo 4).
- **Live updates**: desde jun/2026 as abas de e-mail e calendário atualizam sem refresh; e desde
  fev/2026 mudanças de colegas aparecem na hora (via SSE).
- Painel lateral: abrir um registro relacionado abre ao lado, não navega — preserva contexto.

## Como adaptar no CRM-ROBUSTO

Temos quase tudo, disperso: `lead-detail-drawer.tsx`, `activity-timeline.tsx`, `field-group-list.tsx`,
`LeadActivity`, `CustomFieldGroup`, `Task`, `Message`. Falta **unificar em uma página com abas** e
**enriquecer a timeline**.

### 3.1 Timeline unificada — o item de maior valor

Hoje `LeadActivity` só registra o que o backend explicitamente grava. A timeline do lead deveria ser
a **fusão ordenada** de: mudanças de campo, mudanças de estágio, tarefas (criada/concluída),
mensagens WhatsApp (resumidas), transferências de setor/responsável, disparos de broadcast, execuções
de workflow e notas.

Duas estratégias:

- **(A) União na leitura** — `GET /leads/:id/timeline` faz N queries (activities, tasks, messages,
  broadcast targets), normaliza para um shape comum e ordena por data em memória, com paginação por
  cursor de tempo. Simples, sem migração, mas paginação fica chata com 5 fontes.
- **(B) Tabela de eventos materializada** — evoluir `LeadActivity` para uma `RecordEvent` genérica
  e escrever nela a partir de um `EventEmitter` do Nest. Paginação trivial, uma query só.

**Recomendo (B)**, com a mesma pegada do fan-out deles:

```prisma
model RecordEvent {
  id           String   @id @default(uuid())
  tenant_id    String
  /// Alvo: 'lead' | 'contact' | 'company' | 'conversation'
  target_type  String
  target_id    String
  /// Vocabulário fechado: 'record.created', 'field.updated', 'stage.moved',
  /// 'task.created', 'task.done', 'message.inbound', 'message.outbound',
  /// 'sector.transferred', 'workflow.run', 'note.created', 'broadcast.sent'
  event        String
  /// Diff só dos campos que mudaram: { campo: { de, para } }. Nunca o registro inteiro.
  diff         Json?
  /// Payload leve para render sem join (nome do estágio, preview da msg, título da tarefa).
  meta         Json?
  actor_id     String?          // null = sistema/automação
  actor_kind   String   @default("user") // user | system | workflow | ai
  happens_at   DateTime @default(now())

  @@index([tenant_id, target_type, target_id, happens_at(sort: Desc)])
  @@index([tenant_id, event, happens_at])
}
```

Emissão: um `RecordEventService.emit()` chamado por um listener do `@nestjs/event-emitter`, e
**nunca** pelo controller — assim o evento sai igual vindo da UI, da API pública ou de um workflow.
Fan-out: ao emitir para uma `Conversation`, gravar **também** para o `Lead` dono. Duplica linha, mas
economiza join em toda leitura de timeline; com índice composto isso escala bem.

Diff de campo: calcular no service comparando o `before` (já buscado para autorização) com o `after`,
filtrando campos ruidosos (`updated_at`, `unread_count`, `last_message_at`). Sem esse filtro a
timeline vira spam.

```
GET /leads/:id/timeline?cursor=<iso>&limit=30&kinds=field,stage,task
```

### 3.2 Abas e layout

Não precisamos de PageLayout configurável agora (é o maior sobre-engenheiramento possível para o
nosso porte). Basta:

- Abas **fixas em código**: `Visão geral` | `Conversa` | `Tarefas` | `Timeline` | `Arquivos`.
- Dentro de "Visão geral", os **grupos de campos vêm do banco** — já temos `CustomFieldGroup` com
  `ordem` e `escopo`. Renderizar `<FieldGroupSection>` colapsável por grupo. Isso já é 80% do
  widget "Fields" deles.
- Guardar a aba ativa em `localStorage` por escopo (não na URL) e o estado colapsado dos grupos
  também — preferência pessoal não pertence à URL.
- Página cheia em `/leads/[id]` **e** o mesmo componente dentro do drawer. Um só componente,
  dois containers: é o que o Twenty faz com o side panel.

### 3.3 Edição inline na ficha

Reutilizar o **mesmo** componente de célula do capítulo 4 (`<EditableField />`), configurado por
`CustomFieldDef.tipo` — já temos `field-input.tsx` e `coerceValue()` no backend. Campos com
`api_only: true` renderizam read-only com badge, campos com `visible: false` não renderizam. Isso
já está modelado; falta só o comportamento de edição.

### 3.4 Realtime

Já emitimos `lead:updated` via Socket.IO e temos `lead-events.ts` separando chaves de controle.
Estender: emitir `lead:event` quando um `RecordEvent` for criado, e no front fazer
`queryClient.setQueryData(['timeline', leadId], prepend)`. Não invalidar a query — prepend, senão
a timeline pisca a cada mensagem recebida.

## Esforço estimado

**G** no total, mas fatiável: `RecordEvent` + emissão + endpoint [M]; abas + reuso do drawer [M];
grupos de campos colapsáveis [P]; realtime na timeline [P].
Sub-item **[P] de altíssimo retorno**: só o `diff` de campos alterados na timeline, sem o resto.

---

# 4. Edição inline em tabela (edit-in-place, updates otimistas)

## Como o Twenty faz

### A máquina de estados da célula

O contexto de uma célula da tabela carrega três coisas: **`isInEditMode`**, **`hasSoftFocus`** e a
**posição da célula** (linha/coluna). Isso define três estados distintos:

1. **Display** — só texto, sem borda.
2. **Soft focus** — a célula está "selecionada" pelo teclado, com contorno, mas **não** está em
   edição. As setas movem o soft focus pela grade, como numa planilha.
3. **Edit mode** — um overlay (`OverlayContainer`, unificado entre a célula da tabela e a célula
   inline da ficha) renderiza o editor apropriado ao tipo do campo, podendo **transbordar** os
   limites da célula (dropdown de relação, seletor de data, editor de múltiplos e-mails).

Transições: `Enter` ou duplo clique em soft focus → edit. `Enter` em edit → persiste e volta para
soft focus (na mesma célula). `Escape` → descarta e volta para soft focus. `Tab` → persiste e move
para a próxima coluna. Clique fora → persiste. Digitar direto com soft focus → entra em edit já com
o caractere digitado (comportamento de planilha, muito importante para data-entry).

**Hotkey scopes** são a peça de infraestrutura que faz isso não virar caos: só um escopo escuta as
setas por vez. Quando um dropdown abre, ele empilha o próprio escopo; ao fechar, devolve. Sem isso,
`Escape` fecharia o dropdown *e* a célula *e* o painel lateral ao mesmo tempo.

Nota de engenharia deles: `RecordTableCell` já foi alvo de otimização de ~5x. Numa tabela de 50
linhas × 15 colunas são 750 células — cada uma assinando estado global é morte por re-render. A
solução deles foi estado por componente (Jotai) em vez de estado por objeto (Recoil), e contexto
de célula memoizado.

### Persistência e updates otimistas

- Salvamento é **por campo**, não por linha: uma mutação de update com o único campo alterado.
- O Apollo Client normaliza por `__typename:id`, então a resposta da mutação atualiza a célula, a
  ficha aberta no painel lateral e o card do kanban de uma vez. O update otimista é escrito no cache
  antes da resposta; erro faz rollback e mostra toast.
- Campos compostos (nome, endereço, telefones, e-mails) são editados como um todo e enviados como
  objeto — daí a existência de "sub-campos" para filtro/ordenação.
- Não há "salvar" explícito em lugar nenhum. O corolário disso aparece na doc de workflows: o
  trigger "Record is Created" é ruim para criação manual justamente porque o auto-save dispara antes
  do usuário terminar de preencher. **Autosave tem custo semântico** — vale lembrar disso.

### Edição em massa

Existe um fluxo de "atualizar vários registros" acionável pelo ⌘K / barra de ação quando há
seleção múltipla: escolhe-se o campo e o valor, e aplica-se a todos.

## Como adaptar no CRM-ROBUSTO

Hoje não temos vista de tabela — só kanban. Então isto é feature nova, e a chance de fazer certo
desde o começo.

### Componentes

```
apps/web/src/components/record-table/
  record-table.tsx            // virtualização (@tanstack/react-virtual), header sticky
  table-row.tsx
  table-cell.tsx              // display | softFocus | edit
  cell-editors/
    text-cell.tsx  number-cell.tsx  currency-cell.tsx  date-cell.tsx
    select-cell.tsx  multiselect-cell.tsx  boolean-cell.tsx  relation-cell.tsx
  use-table-navigation.ts     // soft focus + setas + Tab/Enter/Escape
  use-hotkey-scope.ts         // pilha de escopos
```

Mapeamento direto do nosso `FIELD_TYPES` (`text`, `textarea`, `number`, `currency`, `date`,
`select`, `multiselect`, `boolean`, `url`, `phone`, `email`) para um editor cada. O registry vive
num só lugar, e o **mesmo** registry serve tabela, ficha e drawer — como eles fizeram ao unificar o
overlay.

### Soft focus sem re-render global

```ts
// Zustand com selector — só a célula focada re-renderiza.
interface TableFocusState {
  focus: { row: number; col: number } | null;
  editing: { row: number; col: number } | null;
  move: (dr: number, dc: number) => void;
  enterEdit: (seed?: string) => void;
  exitEdit: (commit: boolean) => void;
}
```

Na célula: `useTableFocusStore(s => s.focus?.row === row && s.focus?.col === col)`. Zustand com
selector booleano evita o problema que eles resolveram com Jotai. Virtualizar as linhas com
`@tanstack/react-virtual` — sem isso, 1000 leads travam.

Regras de teclado (copiar todas):

| Tecla | Em soft focus | Em edição |
|---|---|---|
| `↑ ↓ ← →` | move o foco | move o cursor dentro do input |
| `Enter` | entra em edição | salva e volta a soft focus |
| `Tab` | move para a direita | salva e move para a direita |
| `Esc` | limpa o foco | descarta e volta a soft focus |
| caractere | entra em edição com o caractere | digita |
| `Espaço` | alterna boolean / abre select | — |
| `⌘/Ctrl + Enter` | abre a ficha do lead | — |

### Update otimista com TanStack Query

Não temos normalização de cache (Apollo). Fazer explicitamente:

```ts
const updateField = useMutation({
  mutationFn: ({ id, field, value }: Patch) =>
    api.patch(`/leads/${id}`, { [field]: value }),

  onMutate: async ({ id, field, value }) => {
    await queryClient.cancelQueries({ queryKey: ['leads'] });
    const snapshots = queryClient.getQueriesData({ queryKey: ['leads'] });
    // patch em TODAS as listas em cache + na ficha aberta
    queryClient.setQueriesData({ queryKey: ['leads'] }, patchLeadInPages(id, field, value));
    queryClient.setQueryData(['lead', id], (l) => l && { ...l, [field]: value });
    return { snapshots };
  },

  onError: (err, _vars, ctx) => {
    ctx?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));
    toast.error('Não foi possível salvar. Alteração desfeita.');
  },

  // Nada de invalidateQueries aqui: o WebSocket `lead:updated` já reconcilia,
  // e invalidar refaz a listagem inteira a cada tecla salva.
});
```

Escrever `patchLeadInPages` como **função pura em `lib/`** e cobrir com Jest — é a mesma decisão já
tomada em `lead-filters.ts` e `lead-order.ts`, e aqui vale ainda mais porque o bug (patch numa
página errada do cache infinito) é silencioso.

### Backend

`PATCH /leads/:id` já existe. Ajustes:
1. Aceitar patch parcial de **um** campo e devolver **só** o registro atualizado (payload magro).
2. Emitir `RecordEvent` com o diff (capítulo 3).
3. **Idempotência/last-write-wins**: enviar `updated_at` como `If-Unmodified-Since` lógico e
   devolver `409` se mudou. Numa tabela com vários atendentes editando, isso evita o clássico
   "meu colega apagou o que eu escrevi".
4. Edição em massa: já temos `POST /leads/bulk/*`; generalizar para
   `POST /leads/bulk/update { ids, patch }` com validação Zod contra `field-schema.ts`.

### Onde discordar do Twenty

**Não fazer autosave em campo de texto longo.** Eles fazem, e a própria doc deles admite o efeito
colateral (trigger disparando antes do preenchimento). Para `textarea` e observações, usar
debounce de 1,5 s **mais** um indicador "Salvando…/Salvo" — mesmo custo de implementação, muito
menos surpresa.

## Esforço estimado

**M/G**. `<EditableField>` + registry de editores + update otimista é [M] e reaproveitável em três
telas. A tabela virtualizada com soft focus e teclado completo é [G] por si só. Caminho recomendado:
entregar `<EditableField>` primeiro na ficha (capítulo 3), e só depois a tabela.

---

# 5. Agregações no kanban (somas/contagens por coluna, agrupamentos)

## Como o Twenty faz

### Modelo

Duas colunas na **View**: qual operação de agregação e qual campo agregar. E, no PR que introduziu
o recurso, esses dois valores **se propagam quando você duplica a view** — detalhe pequeno que evita
o usuário reconfigurar tudo ao criar uma variação do pipeline.

Além disso, cada `ViewField` pode ter sua própria operação de agregação — é o que alimenta o
**rodapé de coluna na tabela** e o número no **header da coluna do kanban**.

Operações: **Count**, **Sum**, **Average**, **Min**, **Max**. Para campos de moeda a operação
incide sobre o sub-campo de valor (eles guardam moeda em micros, então somam o `amountMicros` e
formatam depois). Nos dashboards a lista é mais rica (percentuais, contagens de vazio/não-vazio,
granularidade de data — dia/semana/mês/trimestre/ano, e "dia da semana" agregado).

### UX

- O número já aparece por padrão no header da coluna do kanban (contagem de cards). **Clicar no
  número** abre um dropdown com "escolha a operação" + "escolha o campo". Excelente affordance: o
  que parece um rótulo é na verdade o botão de configuração.
- O resultado aparece ao lado do nome do estágio ("Negociação · R$ 482.300").
- Configurado por view: o mesmo pipeline pode ter uma view "Pipeline (valor)" e outra
  "Pipeline (contagem)".
- Colunas do kanban: reordenáveis por arrasto (jul/2026), redimensionáveis com largura persistida
  (jun/2026), e ocultáveis pelo `ViewGroup`.
- Mover card entre colunas **preserva a ordenação ativa** da view (jun/2026) — antes disso o card
  ia parar em posição arbitrária.
- Agrupar por **relação** (ex.: por responsável), não só por select (jul/2026).

### API (conceitual)

A agregação **vem junto com a página de registros**, não numa chamada separada: a query pede os
registros da coluna e, no mesmo round-trip, um campo derivado com o nome composto pela operação e
pelo campo (algo como "soma do valor", "contagem do id"). O servidor resolve com um `GROUP BY` e
devolve. Isso importa: **1 request por coluna**, não 2.

## Como adaptar no CRM-ROBUSTO

Já temos `Stage` com `ordem` e `cor` e o kanban com `stage-column.tsx`. Falta o número.

### Backend

Endpoint dedicado (mais simples que embutir na listagem, dado que nosso kanban já busca por
estágio):

```
GET /pipelines/:id/aggregates?view_id=<uuid>
→ { byStage: { "<stage_id>": { count: 42, value: 482300.5 } }, total: {...} }
```

Implementação em **uma** query, não N:

```ts
const rows = await this.prisma.lead.groupBy({
  by: ['stage_id'],
  where: compileView(view, user).where,   // MESMO where da listagem — capítulo 1
  _count: { _all: true },
  _sum: { valor: true },
  _avg: { valor: true },
  _min: { valor: true },
  _max: { valor: true },
});
```

Cuidados:
- O `where` **tem** que ser o mesmo do compilador de view, senão o total do header não bate com os
  cards visíveis. Esse é o bug número 1 desse tipo de feature.
- Campos customizados numéricos vivem em `Lead.custom_fields` (Json). `groupBy` do Prisma não agrega
  dentro de Json → cair para `$queryRaw` com
  `SUM((custom_fields->>'orcamento')::numeric)` quando o campo agregado for customizado.
  Vale criar um índice de expressão se virar consulta quente.
- Estágios sem lead somem do `groupBy`: preencher com zero no service, senão a coluna vazia fica
  sem número.
- Cache: Redis com TTL de 30 s por `(tenant, view, pipeline)`, invalidado no `lead:updated`.

### Prisma

Basta o `ViewField.agregacao` do capítulo 1:

```prisma
enum AggregateOp {
  COUNT
  SUM
  AVG
  MIN
  MAX
  COUNT_EMPTY
  COUNT_NOT_EMPTY
}
```

Guardar a escolha do kanban como um `ViewField` do campo agregado com `agregacao` preenchida —
evita duas colunas extras na `View` e generaliza de graça para o rodapé da tabela.

### Front

- `<StageColumnHeader>` ganha `<AggregateBadge>`: mostra o valor formatado
  (`Intl.NumberFormat('pt-BR', { notation: 'compact' })` quando passar de 6 dígitos — eles
  adicionaram exatamente essa opção "abreviado vs completo" em jun/2026) e abre um
  `<DropdownMenu>` shadcn com operação + campo.
- Query separada com `staleTime: 30_000`, invalidada no evento `lead:updated` do socket.
- **Roubar:** o clique no número como affordance de configuração.
- **Roubar:** preservar a ordenação da view ao mover card entre colunas. Já temos `lead-order.ts`
  testado — reusar em vez de recalcular posição no drop.
- Rodapé da tabela com o mesmo `<AggregateBadge>` (mesmo componente, container diferente).

## Esforço estimado

**P/M**. Depende do capítulo 1 para o `where` compartilhado. Sem views salvas dá para entregar uma
versão [P] com o filtro atual do kanban. Agregar campo customizado em Json empurra para [M].

---

# 6. Automação de workflows (trigger → ações, versionamento, execução em BullMQ)

## Como o Twenty faz

### Modelo de dados

Quatro entidades, e a separação entre elas é a lição principal:

- **Workflow** — o container nomeado. Aponta para a versão publicada e a versão rascunho.
- **WorkflowVersion** — **o conteúdo real**: o trigger e o grafo de passos, versionado.
  Status: `DRAFT` → `ACTIVE` → `DEACTIVATED` → `ARCHIVED`. Um workflow tem no máximo **uma** versão
  ativa; ativar uma nova arquiva a anterior. O grafo de passos é armazenado como estrutura JSON —
  cada passo com id, nome, tipo, configurações e as arestas para os próximos passos.
- **WorkflowRun** — uma execução. Guarda status (`NOT_STARTED` → `RUNNING` → `COMPLETED` /
  `FAILED`, mais um estado de espera para delay/formulário), o **snapshot da versão** que foi
  executada, o payload do trigger, e a saída acumulada passo a passo.
- **Trigger automatizado** — a materialização do "escutador": para evento de banco, um registro que
  liga (objeto, operação) → workflow; para cron, um agendamento.

**Guardar o snapshot do grafo no run é a decisão certa.** Um run de ontem continua legível mesmo
depois de você reescrever o workflow hoje.

### Triggers

| Trigger | Comportamento |
|---|---|
| `Record is Created` | dispara na criação. A doc **desaconselha** para criação manual, por causa do autosave |
| `Record is Updated` | dispara na atualização; permite listar quais campos observar |
| `Record is Created or Updated` | o recomendado na maioria dos casos |
| `Record is Deleted` | limpeza |
| `Manual` | acionado pelo usuário. Três modos: **Global** (sem registro), **Single** (1 run por registro selecionado), **Bulk** (1 run com o array inteiro — exige Iterator). Aparece no ⌘K e, se `isPinned`, como botão na navbar |
| `On a Schedule` | intervalo (min/hora/dia) ou expressão cron. **Sempre em UTC** |
| `Webhook` | GET/POST numa URL única gerada; para POST é preciso declarar o formato do corpo antes |

Vale notar que triggers funcionam também sobre objetos "de sistema" (membros do workspace, eventos
de calendário, mensagens, tarefas, notas) — não só sobre entidades de negócio.

### Ações

Pelas pastas do executor, os tipos de ação hoje são: **record-crud** (create/update/delete/find/
upsert), **filter**, **if-else**, **iterator**, **delay**, **form**, **mail-sender**,
**http-request**, **code**, **logic-function**, **create-calendar-event**, **ai-agent**,
**tool-backed** e um passo vazio (placeholder no builder).

Semânticas importantes:

- **Branches rodam em paralelo por padrão** e **não se juntam sozinhos**. Para condicional, o padrão
  é uma branch por caminho com um `Filter` na primeira posição e condições mutuamente exclusivas.
  (Há um nó `if-else` no executor, mais recente que a doc de FAQ.) Para juntar, conecta-se as pontas
  ao mesmo passo seguinte, que executa depois de todas.
- **Filter é uma comporta, não um retorno de dados.**
- **Iterator** é sequencial, expõe `{{iterator.currentItem}}` e `{{iterator.index}}` (base 0), e as
  branches internas precisam voltar ao iterator para fechar o laço.
- **Search Records devolve no máximo 200 registros.**
- **Upsert** casa por campo único (e-mail, domínio, id, ou qualquer campo marcado como único), e a
  doc recomenda **um** identificador só — mais de um piora o casamento.
- **Delay** consome crédito no momento da execução, independentemente da duração; a espera é grátis.

### Variáveis entre passos

Templating com chaves duplas: `{{trigger.object.email}}`, `{{searchRecords[0].name}}`,
`{{code.calculatedValue}}`, `{{iterator.currentItem}}`. Há um seletor visual de variáveis que
insere a expressão. A saída de um passo de código é um objeto, e as propriedades aninhadas ficam
selecionáveis nos passos seguintes.

### Execução, limites e falhas

- Enfileiramento em **BullMQ**, com módulo de fila próprio no servidor.
- Código roda num **interpretador isolado** (há um `code-interpreter` no core), com **timeout padrão
  de 5 minutos e máximo de 15**.
- **Rate limits por workspace**: limite suave de **100 runs/minuto** (excedentes ficam em
  "Not Started", enfileirados) e limite duro de **5.000 runs/hora** (excedentes falham na hora).
- **Retomar do passo que falhou** (jun/2026) — reexecuta a partir do ponto da falha, não do começo.
  Isso só é possível porque a saída de cada passo é persistida incrementalmente.
- **Botão de parar** um run em andamento (dez/2025).
- **Logs passo a passo** (jun/2026): entrada, saída, chamadas de IA, saída do código, requisições
  HTTP e e-mails — por passo.
- A doc alerta para **desativar workflows antes de importar CSV grande**, e para o risco de
  recursão (um workflow que atualiza o registro que o dispara).
- Modelo de cobrança por **créditos**, com custo variável por tipo de ação (CRUD barato, código/
  HTTP/IA caro). Rascunhos não consomem.

### UX do builder

Canvas de nós com painel lateral de configuração (que abre **ao lado**, não por cima). Dá para
duplicar nó, trocar o tipo de um nó, renomear passos, testar com dados de amostra antes de ativar,
e há um "organizar workflow" (botão direito no canvas) que arruma o grafo automaticamente.

## Como adaptar no CRM-ROBUSTO

Temos `automation.service.ts` + `Stage.auto_action`/`sla_config`/`cadence_config` +
`PIPELINE_AUTO_ACTIONS_QUEUE`. Ou seja: **automação existe, mas amarrada ao estágio e configurada
por Json solto**. O salto é extrair um motor genérico.

### Prisma

```prisma
enum WorkflowStatus     { DRAFT ACTIVE DEACTIVATED ARCHIVED }
enum WorkflowRunStatus  { ENQUEUED RUNNING WAITING COMPLETED FAILED CANCELLED }
enum WorkflowTriggerKind {
  LEAD_CREATED
  LEAD_UPDATED
  LEAD_CREATED_OR_UPDATED
  STAGE_CHANGED
  MESSAGE_RECEIVED       // exclusivo nosso: chegou WhatsApp
  MESSAGE_SENT
  NO_REPLY_FOR           // exclusivo nosso: SLA de resposta
  TASK_OVERDUE
  MANUAL
  SCHEDULE
  WEBHOOK
}

model Workflow {
  id                  String         @id @default(uuid())
  tenant_id           String
  nome                String
  descricao           String?
  status              WorkflowStatus @default(DRAFT)
  active_version_id   String?        @unique
  draft_version_id    String?        @unique
  created_by          String?
  created_at          DateTime       @default(now())
  updated_at          DateTime       @updatedAt

  versions WorkflowVersion[] @relation("workflow_versions")
  runs     WorkflowRun[]

  @@index([tenant_id, status])
}

model WorkflowVersion {
  id           String         @id @default(uuid())
  workflow_id  String
  tenant_id    String
  numero       Int            // 1, 2, 3...
  status       WorkflowStatus @default(DRAFT)
  /// { kind, config } — validado por Zod discriminado em WorkflowTriggerKind
  trigger      Json
  /// [{ id, nome, tipo, config, next: [stepId] }] — DAG. Zod valida ciclos.
  steps        Json
  created_at   DateTime       @default(now())
  activated_at DateTime?

  workflow Workflow @relation("workflow_versions", fields: [workflow_id], references: [id], onDelete: Cascade)

  @@unique([workflow_id, numero])
  @@index([tenant_id, status])
}

model WorkflowRun {
  id            String            @id @default(uuid())
  tenant_id     String
  workflow_id   String
  version_id    String
  /// SNAPSHOT do grafo executado — o run continua legível se a versão mudar.
  snapshot      Json
  status        WorkflowRunStatus @default(ENQUEUED)
  trigger_payload Json
  /// { [stepId]: { status, startedAt, endedAt, output, error } } — gravado incrementalmente.
  steps_output  Json              @default("{}")
  /// Onde retomar num retry.
  failed_step_id String?
  lead_id       String?           // alvo, quando houver — permite mostrar runs na ficha
  started_at    DateTime          @default(now())
  ended_at      DateTime?

  @@index([tenant_id, workflow_id, started_at(sort: Desc)])
  @@index([tenant_id, status])
  @@index([lead_id, started_at(sort: Desc)])
}
```

### Motor em NestJS + BullMQ

Duas filas, e essa separação importa:

```ts
export const WORKFLOW_TRIGGER_QUEUE = 'workflow-trigger';  // avalia se dispara → cria o run
export const WORKFLOW_STEP_QUEUE    = 'workflow-step';     // executa UM passo
```

**Um job por passo**, não um job por run. Vantagens: um passo lento (HTTP externo) não bloqueia o
worker; retry do BullMQ é por passo; `delay` vira literalmente um job agendado
(`{ delay: ms }`) sem worker parado; e "retomar do passo que falhou" é reenfileirar um job.

```
WORKFLOW_TRIGGER_QUEUE
  → resolve versão ACTIVE + avalia condições do trigger
  → cria WorkflowRun (snapshot) e enfileira o primeiro passo

WORKFLOW_STEP_QUEUE  (job = { runId, stepId })
  → resolve variáveis {{...}} contra steps_output + trigger_payload
  → despacha para o executor do tipo (mapa tipo → classe)
  → grava output em steps_output (update parcial no Json)
  → enfileira os próximos stepIds (paralelismo natural = N jobs)
  → sem próximos e sem pendentes → status COMPLETED
```

Guardas obrigatórias (aprender com os limites deles antes de sofrer):
- **Rate limit por tenant** — usar o `limiter` do BullMQ por grupo (`{ groupKey: tenantId }`) e um
  contador em Redis. Sugestão inicial: 60 runs/min, 2.000/h por tenant.
- **Anti-recursão** — propagar um `causationId`/`depth` no payload; recusar acima de profundidade 5.
  Atualizações feitas por workflow devem marcar `actor_kind: 'workflow'` para que o listener possa
  ignorá-las como gatilho quando o workflow for o mesmo.
- **Timeout por passo** (30 s para HTTP, 60 s para código) e `attempts: 3` com backoff exponencial
  só em erro de rede.
- **Idempotência**: `jobId` determinístico (`${runId}:${stepId}:${attempt}`).

### Ações do MVP (recortadas para WhatsApp CRM)

Não replicar os 14 tipos deles. As que rendem no nosso domínio:

| Ação | Nota |
|---|---|
| `send_whatsapp` | reusa `MESSAGES_SEND_QUEUE` — nunca enviar direto do executor |
| `send_quick_reply` | usa `QuickReply` existente |
| `update_lead` | patch parcial com o mesmo Zod do `PATCH /leads/:id` |
| `move_stage` | reusa a regra de `campos_obrigatorios` do estágio |
| `assign_user` / `assign_sector` | reusar `QueuePointer` (round-robin já existe!) |
| `add_tag` / `remove_tag` | |
| `create_task` | |
| `delay` | job agendado |
| `filter` | comporta booleana sobre o payload |
| `http_request` | com allowlist de domínios por tenant |
| `webhook_out` | reusa `OUTBOUND_WEBHOOKS_QUEUE` |
| `ai_generate` | reusa o módulo `ai/` — gerar texto/classificar e devolver ao contexto |

**Não implementar `code` (JS arbitrário) no MVP.** É onde mora o risco: exige sandbox real (isolate/
worker separado, sem rede, sem `fs`), e o Twenty precisou de um interpretador dedicado para isso.
Se surgir demanda, resolver com `http_request` para um n8n — que já usamos (`docs/n8n/`).

### Variáveis

Adotar a sintaxe deles (`{{...}}`), porque é a que todo mundo já conhece de n8n/Zapier:
`{{trigger.lead.nome}}`, `{{steps.buscar_leads[0].telefone}}`, `{{iterator.currentItem.id}}`.
Resolver com uma função pura em `packages/shared` — testável com Jest, e o front usa a **mesma**
função para o preview do valor no builder. Escapar sempre antes de interpolar em texto de mensagem.

### Versionamento e UX

- Editar workflow ativo **cria/atualiza o rascunho**, nunca a versão ativa. `POST
  /workflows/:id/activate` promove o rascunho e arquiva o anterior.
- `POST /workflows/:id/versions/:v/use-as-draft` para rollback (copia versão antiga para rascunho).
- Builder: canvas com `@xyflow/react` (React Flow) — é a escolha óbvia e já é MIT.
  Painel de configuração **ao lado**, não modal (copiar essa decisão deles de dez/2025).
- Aba **Runs** dentro do workflow e também na ficha do lead (`WorkflowRun.lead_id`), com timeline
  por passo: status, entrada, saída, erro. Botão **Retomar do passo que falhou** e **Parar**.
- Trigger manual aparecendo no ⌘K (capítulo 2) — integração barata e de alto impacto percebido.

### O que fazer com a automação atual

Migrar `Stage.auto_action`, `sla_config`, `cadence_config` para workflows gerados
automaticamente (script de migração criando um `Workflow` por regra existente) e manter o
`auto-actions.processor.ts` como um executor legado por 1–2 releases. Não fazer big bang.

## Esforço estimado

**G** (o maior do documento). Fatiar:
1. Schema + CRUD + versionamento, sem executor [M]
2. Motor de execução (trigger queue + step queue + 5 ações) [G]
3. Builder visual em React Flow [G]
4. Aba de runs + logs por passo + retry [M]
5. Migração das auto-actions de estágio [M]

Entregar 1+2 com trigger `MESSAGE_RECEIVED`/`STAGE_CHANGED` e um builder **em formulário** (não
canvas) já cobre a maior parte do valor. O canvas é a parte cara e a menos essencial.

---

# 7. Outras coisas do Twenty de hoje que vale copiar conceitualmente

### 7.1 Agentes de IA com permissão de papel

O modelo mais interessante deles não é "IA que responde", é **IA que herda permissões**. Um agente
é definido com prompt de sistema, modelo escolhido, ferramentas disponíveis e um **papel (role)** —
e ele só enxerga/edita o que aquele papel permite. Há ainda a delegação: executar o agente "em nome
de" um membro específico, aplicando as permissões e a autoria dele. Agentes rodam dentro de
workflows, no chat, e o workspace é exposto via **MCP**. Para nós: nosso módulo `ai/` já é
provider-agnóstico; falta o **papel**. Antes de deixar a IA escrever no CRM, ela precisa de um
`AuthUser` sintético passando pelo mesmo `lead-visibility.ts` — senão o copilot de um setor lê lead
de outro. Esforço **M**, e é pré-requisito de segurança para qualquer IA com escrita.

### 7.2 Motor de objetos/campos customizados de verdade

Eles não têm "campos customizados": eles têm um **motor de metadados** onde objeto customizado é
cidadão de primeira classe (ganha endpoint REST/GraphQL, views, permissões e trigger de workflow no
mesmo instante em que é criado), com DDL gerado em runtime no schema do workspace e cache do schema
GraphQL. Copiar isso inteiro seria um erro para nós — é meses de trabalho e vira um banco de dados
dentro do banco de dados. Mas há um recorte barato e valioso: **fazer nossos `CustomFieldDef`
aparecerem automaticamente em todo lugar** (colunas da tabela, filtros, agregações, variáveis de
workflow, exportação CSV, API pública), em vez de só na ficha. Um `FieldRegistry` único no backend
que devolve, por escopo, a lista de campos com tipo, origem (coluna nativa vs Json) e capacidades
(filtrável? ordenável? agregável?). Esforço **M**, e destrava os capítulos 1, 4 e 5 de uma vez.

### 7.3 Permissões em três níveis + delegação

Papéis com permissões por **objeto** (ler/criar/editar/apagar), por **campo** (ver mas não editar;
ou nem ver) e por **linha** (filtro de registro: "vendedor só vê as próprias oportunidades"), com
herança do geral para o específico. Papéis se aplicam a membros, **chaves de API** e **agentes de
IA** — a mesma abstração para os três. Além disso: **impersonation** de usuário para suporte, e
escolha do papel já no convite. Nós temos `UserRole` + setores + `ApiKey`. O que falta e é barato:
(a) permissão por campo, que já cabe no `CustomFieldDef` (adicionar `roles_read`/`roles_write` ou
uma tabela `FieldPermission`); (b) papel na `ApiKey` em vez de acesso total. Esforço **M**.

### 7.4 Importação/exportação industrial

O import deles evoluiu para: casamento automático de coluna→campo por header e tipo de dado,
suporte a **sub-campos** (rótulo de link, telefone secundário), **importação de relações** (ligar
contato à empresa pelo domínio no mesmo CSV), **update de registros existentes via import**
(upsert por campo único), validação com relatório de erros linha a linha e 2.000+ linhas por
arquivo. O front tem um módulo `spreadsheet-import` dedicado. Detalhe operacional que eles
documentam e que a gente vai sofrer se ignorar: **desativar automações antes de importar em massa**
— import de 5.000 leads com workflow de boas-vindas ativo é um incidente. Nós temos `LeadOrigem.IMPORT`
mas nenhum fluxo de import decente. Esforço **M**, e é o item de maior retorno percebido em
onboarding de cliente novo.

### 7.5 Layout e navegação como dado, com live updates

Três coisas pequenas que juntas mudam a sensação do produto: **(a)** side panel que abre *ao lado*
do conteúdo em vez de cobrir (dez/2025) — preserva contexto e é só CSS; **(b)** **live updates**
via SSE, com mudanças de colegas aparecendo sem refresh (fev/2026), inclusive nas abas de e-mail e
calendário (jun/2026) — nós já temos Socket.IO, é só ampliar a cobertura de eventos; **(c)**
**sidebar customizável por usuário** com pastas, favoritos, objetos ocultos e links externos
(fev/2026). O (c) é [P] no nosso caso (uma tabela `SidebarItem` por usuário) e resolve a reclamação
crônica de "tem coisa demais no menu" sem precisar de permissões. O (a) é [P] puro. Esforço
conjunto **P/M**, e é o melhor retorno por hora de trabalho de todo o documento.

---

## Apêndice A — ordem de ataque sugerida

Sequência que maximiza reaproveitamento e minimiza retrabalho:

1. **`FieldRegistry` unificado** (7.2) — pré-requisito silencioso de quase tudo. [M]
2. **`<EditableField>` + registry de editores** na ficha (cap. 4, parte 1). [M]
3. **`RecordEvent` + timeline com diff** (cap. 3.1). [M]
4. **Views salvas: tabelas + compilador no `GET /leads`** (cap. 1, partes 1–2). [M]
5. **Agregações no kanban** (cap. 5) — barato assim que o (4) existir. [P]
6. **Command palette contextual + busca FTS** (cap. 2). [M]
7. **ViewBar + colunas configuráveis + tabela virtualizada** (cap. 1 partes 3–4 + cap. 4 parte 2). [G]
8. **Motor de workflows** (cap. 6) — o maior; começar por schema + executor com 5 ações. [G]

Itens de baixo custo que podem entrar em qualquer momento: side panel ao lado (7.5a), busca no
seletor de campos, clique no número do kanban como affordance, "salvar como nova view" com nome
sugerido.

## Apêndice B — armadilhas identificadas (o que o Twenty aprendeu na dor)

1. **Autosave dispara automação antes da hora.** A própria doc deles desaconselha o trigger
   "record created" para criação manual. Se formos de autosave, o trigger padrão tem de ser
   "criado ou atualizado" com debounce, ou um evento explícito de "registro finalizado".
2. **Filtro/sort não podem sobrescrever a view do time sem confirmação.** O estado "sujo" com
   Salvar/Descartar é o que torna views compartilhadas utilizáveis.
3. **Grupos custam query.** Eles recomendam 10–15 grupos visíveis. Nosso kanban precisa do mesmo
   teto, e por isso o `ViewGroup` com `visible` importa.
4. **Agregação com filtro diferente da listagem = número que não bate.** Compartilhar o compilador
   de `where`.
5. **Branches paralelas que não se juntam sozinhas** confundem todo mundo. Se formos de canvas,
   ou implementamos `if/else` explícito de cara, ou documentamos muito bem.
6. **Import em massa + automação ativa = incidente.** Precisa de um "modo importação" que suspende
   triggers.
7. **750 células assinando estado global = tabela travada.** Estado por célula com selector, e
   virtualização desde o primeiro commit.
8. **Recursão de workflow** (workflow que atualiza o registro que o dispara) precisa de
   profundidade máxima desde o dia 1, não depois do primeiro loop infinito em produção.

## Apêndice C — fontes consultadas

- `twenty.com/releases` — changelog 1.0.0 (jun/2025) a 2.26.0 (jul/2026)
- `docs.twenty.com` — guias de usuário (views, kanban, filtros, workflows, permissões, dashboards,
  importação, IA) e docs de desenvolvedor (apps SDK: objetos, views, page layouts, command menu
  items, timeline activity types, skills & agents, sync & recovery; API, webhooks)
- `docs.twenty.com/llms.txt` — índice completo da documentação
- Listagens de diretório públicas do repositório `twentyhq/twenty` (nomes de módulos e pastas)
- `deepwiki.com/twentyhq/twenty` — visão de arquitetura do monorepo
- Descrição pública do PR de agregações em kanban (twentyhq/twenty#8833)
- `twenty.com/product`

*Nenhum código-fonte AGPL foi copiado. Todo snippet neste documento é original, escrito para o
stack do CRM-ROBUSTO.*
