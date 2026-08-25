# Views salvas de leads (tabela + kanban) — Design

> Rodada "CRM profissional" com referência conceitual no Twenty (ver
> `docs/superpowers/research/2026-08-24-twenty-reference.md`, seção 1, e o aviso
> legal: reimplementação própria, nunca código AGPL). Aprovado por Yuri em
> 25/08/2026.

## Objetivo

Cada usuário monta e salva "views" de leads com nome: quais colunas aparecem (e
em que ordem/largura), quais filtros, qual ordenação e qual modo (lista ou
kanban). Views pessoais ou compartilhadas com o tenant. Nasce junto o **modo
Lista** — tabela de leads que hoje não existe (só há kanban).

**Fora de escopo desta etapa:** edição inline nas células (item 4 da rodada,
construirá em cima desta tabela); esconder/reordenar colunas de etapa do kanban
por view; ordenação por campo customizado (Json path) no servidor; multi-sort.

## Estado atual (o que se aproveita)

- `LeadView` (schema.prisma): `nome`, `filtros Json`, `user_id` (null =
  compartilhada), `tenant_id`. CRUD em `apps/api/src/modules/lead-views/`
  (sanitização por whitelist `CHAVES_PERMITIDAS`, guard de role no controller
  para compartilhadas).
- `apps/web/src/lib/lead-filters.ts`: serialização/hidratação dos filtros
  (padrão a seguir para a config nova; coberto pelo jest do web).
- `lead-filter-panel.tsx` (kanban): painel de filtros + UI atual de views.
- `lead-detail-drawer.tsx`: detalhe do lead, reusado pela tabela.
- `GET /api/leads`: filtros ricos + `limit`/`offset`; ordenação hoje fixa
  (`ultima_interacao desc nulls last`).
- `field-schema.ts` (`NATIVE_FIELDS`) + `CustomFieldDef`: universo de campos.

## 1. Modelo de dados e API

`LeadView` ganha 4 colunas, todas com default (views antigas continuam válidas
sem migração de dados):

```prisma
  tipo_padrao String @default("kanban") // 'kanban' | 'lista' — modo ao abrir a view
  sort        Json   @default("{}")     // { campo: string, dir: 'asc' | 'desc' }
  colunas     Json   @default("[]")     // tabela: [{ key: string, width?: number }] em ordem
  card_fields Json   @default("[]")     // kanban: chaves visíveis no card ([] = card padrão)
```

Migração: SQL manual (banco poluído — nunca `migrate deploy`), padrão do
runbook de `2026-08-24-tenant-billing.sql` (ADD COLUMN IF NOT EXISTS, aplicar
via node+Prisma no container).

Sanitização no `LeadViewsService` (mesmo espírito do `sanitizarFiltros`):

- `tipo_padrao`: só `'kanban' | 'lista'`; outro valor → default.
- `sort.campo`: whitelist de ordenáveis (abaixo); `dir` só `asc|desc`.
- `colunas[].key` e `card_fields[]`: válidos = chaves de `NATIVE_FIELDS` + o
  identificador de `CustomFieldDef` que serve de chave em `Lead.custom_fields`
  (o mesmo formato, um só — conferido no create/update com consulta ao tenant);
  chave desconhecida é descartada em silêncio. `width` numérico 60–640px.

API: mesmos endpoints CRUD `/lead-views`, payload estendido com os 4 campos
(todos opcionais). Regras de autoria/compartilhamento intactas.

`GET /api/leads` ganha `sort` + `dir` com whitelist server-side:
`nome`, `created_at`, `ultima_interacao`, `valor`, `temperatura`,
`proximo_followup`. Param fora da whitelist → ordenação padrão atual (não é
erro). Nulls last nos anuláveis (`temperatura` é NOT NULL — ordenação simples).

## 2. Modo Lista (`/leads`)

Rota nova `apps/web/src/app/(dashboard)/leads/page.tsx` + componentes em
`apps/web/src/components/leads/`:

- Tabela paginada server-side (`limit`/`offset` existentes; 50 por página).
- Colunas da view ativa; menu "Colunas": olho mostra/esconde, drag reordena,
  campo de busca no seletor (nativos + customizados do tenant).
- Largura de coluna arrastável; persiste na view (estado sujo, ver §3).
- Célula renderiza por tipo de campo (texto, número/moeda, data, select,
  tags, temperatura). Campo custom lê `Lead.custom_fields`.
- Clique na linha abre `lead-detail-drawer` (reuso; nenhuma tela de detalhe
  nova).
- Sem edição inline nesta etapa.

## 3. ViewBar + estado sujo

Componente compartilhado `apps/web/src/components/leads/view-bar.tsx`, usado em
`/leads` e `/kanban`:

- Seletor de view (pessoais + compartilhadas, agrupadas), alternância
  Lista/Kanban (navega entre as rotas mantendo a view ativa), chips de filtros
  ativos, botão que abre o `lead-filter-panel` atual.
- **Estado sujo:** mexer em filtro/sort/coluna NUNCA grava na view salva.
  A mudança fica em estado local e a barra mostra `Salvar` (grava na view,
  se editável pelo usuário) · `Descartar` (volta ao salvo) · `Salvar como
  nova view`. É o contrato central de UX: explorar não destrói a view do time.
- Criar/editar view compartilhada: guard atual do controller (GERENTE+).
- Última view + último modo abertos: localStorage (conveniência por
  navegador; com storage indisponível, abre a primeira view ou sem view).
- Sem view ativa = comportamento de hoje (todos os leads, colunas default).

## 4. Kanban

O kanban passa a ler a view ativa:

- Filtros: já funcionava com as views antigas; passa a vir da ViewBar.
- `sort`: ordena os cards DENTRO de cada coluna de etapa.
- `card_fields`: controla quais campos o `lead-card` mostra (`[]` = card
  padrão atual).
- Colunas de etapa: intocadas (ordem/visibilidade são do pipeline do time).

## Erros e compatibilidade

- View antiga (só `filtros`) abre normal: defaults dos campos novos.
- Json inesperado vindo do banco: hidratação defensiva no front (padrão
  `fromSaved` de `lead-filters.ts`) — campo inválido cai no default, tela
  nunca quebra.
- View apagada por outro usuário enquanto ativa: 404 no refetch → toast +
  cai para "sem view".

## Testes

- API (jest): sanitização dos 4 campos novos (chave inválida descartada,
  width clampado, tipo_padrao/dir fora do domínio → default); whitelist de
  `sort` na listagem de leads (param inválido → ordenação padrão).
- Web (jest, `lib/`): serialização/hidratação da config de view
  (`lib/lead-view-config.ts`, novo, no padrão de `lead-filters.ts`).
- Web: `tsc --noEmit` + `npm run build`; conferência visual em produção.
