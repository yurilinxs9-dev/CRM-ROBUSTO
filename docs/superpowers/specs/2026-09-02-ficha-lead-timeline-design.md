# Ficha do lead unificada com timeline — design

Data: 2026-09-02. Item 3 da rodada de profissionalização com o Twenty como
referência (`docs/superpowers/specs` anteriores: views salvas e Ctrl+K já no ar).
Referência é só de comportamento e visual; o núcleo do Twenty é AGPL-3.0 e
nenhum código dele entra aqui.

## Objetivo

Hoje o lead aparece em três superfícies distintas: o drawer do kanban
(`components/kanban/lead-detail-drawer.tsx`, abas Principal / Estatísticas /
Mídia / Config, com a Ficha 360 dentro), o sheet do chat
(`components/chat/lead-details-sheet.tsx`) e a lista. A aba Estatísticas é só a
lista de `LeadActivity`; a aba Mídia é um aviso "galeria não disponível" porque
não existe endpoint. Notas internas existem apenas dentro do chat.

Esta rodada cria **uma página própria por lead** (`/leads/[id]`) que reúne
campos editáveis inline, Ficha 360, galeria de mídia e uma **timeline única**
com conversas, notas internas, tarefas, lembretes da IA e eventos do lead.

## Decisões tomadas com o Yuri (2026-09-02)

1. Superfície: página própria `/leads/[id]`, duas colunas. Drawer e sheet
   continuam existindo nesta rodada e ganham só o link "Abrir ficha completa".
2. Mensagens na timeline entram **agrupadas por sessão de conversa**: um item
   por bloco de mensagens, com corte de 30 minutos sem mensagem. Cada mensagem
   individual NÃO vira item.
3. Notas: reaproveitar a **nota interna do chat** (`Message.is_internal_note`,
   `POST /api/messages/internal-note`, com `mentioned_user_ids`). Nada de tabela
   nova. Nota escrita na ficha aparece no chat e vice-versa. Menção `@usuário`
   entra agora, com autocomplete e notificação, porque o backend já faz tudo.
4. Edição dos campos: **inline campo a campo** (clica, edita, Enter ou blur
   salva, Esc cancela). Sem botão salvar.
5. Escopo: a versão completa (Ficha 360, mídia e config na página), não a
   magra.
6. Celular: colunas empilham; caixa de nota fixa no rodapé.
7. Ctrl+K continua abrindo o **chat** ao escolher um lead. O chat é a tela
   principal do CRM de WhatsApp; a ficha é destino secundário.

## Layout

Desktop (≥ 1024px): grade de duas colunas, esquerda fixa de ~380px, direita
fluida. Ambas rolam de forma independente; o cabeçalho da esquerda fica
visível.

**Coluna esquerda**

- Cabeçalho: foto (`foto_url`), nome (inline), temperatura (inline, select),
  etapa (inline, select escopado pelo pipeline atual; no kanban individual usa
  as etapas do dono, mesma regra do drawer), responsável (inline; usa
  `/claim`, `/reassign` ou `/return-to-pool` conforme o caso, com as mesmas
  guardas de papel do drawer), instância WhatsApp (leitura), tags (`TagPicker`
  existente). Botão "Abrir chat" (`/chat/[id]`). Selo "Disponível" quando o
  lead está na nuvem, igual ao kanban.
- Campos: telefone, e-mail, empresa, cargo, valor estimado — todos inline.
- Campos personalizados por grupo: `FieldGroupList` existente
  (`schema`, `escopo`, `values`, `onChange`); cada campo salva ao mudar via
  PATCH `dados_custom`, sem botão.
- Contatos vinculados: `LeadContactsBlock` existente.
- Ficha 360: o componente `Ficha360` de hoje, dentro de um bloco colapsável,
  fechado por padrão no celular e aberto no desktop.
- Config: somente o que é do lead (atribuir, setor, privado). O `FieldEditor`
  da aba Config do drawer edita o **esquema** de campos do tenant, não o lead;
  ele NÃO entra na ficha (fica onde está e em Ajustes).

**Coluna direita** — abas "Atividade" e "Mídia".

- Atividade: no topo o `NotaInternaComposer` (textarea, autocomplete de `@`,
  Ctrl+Enter envia); abaixo, filtros por tipo (Tudo, Conversas, Notas,
  Tarefas, Eventos) como toggles; depois a timeline, mais nova em cima, botão
  "Carregar mais" ao fim.
- Mídia: grade de miniaturas (imagem, vídeo) e lista (áudio, documento), cada
  item abre a mídia e tem link "ver no chat".

Celular (< 1024px): uma coluna. Cabeçalho, campos, Ficha 360 recolhida, abas
Atividade/Mídia, timeline. A caixa de nota fica fixa no rodapé da aba
Atividade (`position: sticky; bottom: 0`).

## Backend

### `GET /api/leads/:id/timeline?cursor=&limit=`

Papel mínimo: `VISUALIZADOR` (leitura). Devolve
`{ items: TimelineItem[], nextCursor?: string }`, ordenado por `quando`
decrescente. `limit` padrão 40, máximo 100. `cursor` é um ISO date: só entram
itens com `quando < cursor`.

Controle de acesso, na ordem:

1. Lead do tenant do usuário, senão 404.
2. Regra de leitura do lead igual a `getActivities`: `OPERADOR` só se for o
   responsável ou se a instância do lead for uma que ele atende; lead privado
   só o responsável. Fora disso, **404** (não lista vazia — a página precisa
   distinguir "sem acesso" de "sem histórico").
3. Mensagens (sessões, notas, mídia) usam o **mesmo recorte** de `getMessages`
   (foco do gerente, `share_history_enabled`, pool, `assumed_at`). Ver
   "Extração do escopo" abaixo.

Fontes e formato dos itens (`tipo` discrimina):

| tipo | origem | campos além de `id`, `tipo`, `quando` |
|---|---|---|
| `sessao` | `Message` não-nota, agrupadas | `inicio`, `fim`, `total`, `recebidas`, `enviadas`, `ultima_direcao`, `preview` (até 140 chars do último texto; mídia vira "[Imagem]" etc.), `instancia`, `primeira_mensagem_id` (âncora para o chat) |
| `nota` | `Message.is_internal_note` | `conteudo`, `autor {id, nome}`, `mencoes: {id, nome}[]` |
| `atividade` | `LeadActivity` | `subtipo` (= `LeadActivity.tipo`), `descricao`, `dados_antes`, `dados_depois`, `autor` |
| `tarefa` | `Task` com `lead_id` | `titulo`, `tipo_tarefa`, `status`, `scheduled_at`, `completed_at`, `responsavel`; gera **dois** itens quando concluída (criação em `created_at` e conclusão em `completed_at`) |
| `lembrete` | `LeadLembrete` | `motivo`, `avisar_em`, `status`, `origem`; `quando` = `created_at` |

Algoritmo de sessões (helper puro em
`apps/api/src/modules/leads/lead-timeline.ts`, sem Prisma):

- Entrada: mensagens não-nota ordenadas por `created_at` desc, já dentro do
  recorte de visibilidade.
- Percorre e abre nova sessão quando a distância para a mensagem anterior (na
  ordem cronológica) excede 30 minutos (`SESSAO_GAP_MS = 30 * 60_000`).
- `quando` da sessão = `fim` (última mensagem), para ordenar com os outros
  itens.
- Paginação: o serviço busca `limit + 1` mensagens abaixo do cursor e, se a
  última buscada estiver a menos de 30 min da anterior, continua buscando em
  lotes de 50 até fechar a sessão (teto de 500 mensagens por sessão; acima
  disso a sessão fecha à força e o item recebe `truncada: true`). Assim uma
  sessão nunca aparece cortada em duas páginas.

Mesclagem: cada fonte é consultada com `created_at < cursor` e `take: limit`
(mensagens como acima), tudo em `Promise.all`; os itens são concatenados,
ordenados por `quando` desc e cortados em `limit`. `nextCursor` = `quando` do
último item devolvido, se alguma fonte ainda tinha mais. Filtro por tipo é
**do lado do cliente** nesta rodada (o endpoint sempre devolve tudo); se a
fonte de mensagens crescer a ponto de pesar, entra `?tipos=` depois.

### `GET /api/leads/:id/media?cursor=&limit=`

Papel mínimo `VISUALIZADOR`. Mesmo controle de acesso do timeline. Devolve
mensagens com `tipo IN (IMAGE, VIDEO, AUDIO, DOCUMENT)` e não-nota, no recorte
de `getMessages`, ordenadas por `created_at` desc, com `id`, `tipo`,
`media_url`, `media_mimetype`, `media_filename`, `media_thumbnail_path`,
`media_duration_seconds`, `direction`, `created_at`. Cursor
por id como em `getMessages`. Substitui o aviso da aba Mídia do drawer, que
passa a mostrar um link para a ficha. Na implementação: devolve
`media_thumbnail_url` assinada (não o path); só linhas com `media_url` ou
thumbnail; `orderBy created_at desc, id desc`.

### Cursor da timeline (decisão da revisão da Task 2)

O cursor não é um ISO simples: é opaco, no formato
`quando|id|mensagensAntes?`. Cada fonte por data lê com `<=` **inclusivo**
sobre `quando` e o desempate fica em memória, por `(quando, id)` — assim dois
itens no mesmo instante não se perdem entre páginas. A fonte de mensagens usa
o terceiro campo, `mensagensAntes`, com `<` **estrito**, porque uma sessão já
devolvida cobre um intervalo inteiro e precisa ficar de fora da próxima
página. Cursor malformado é tratado como ausente (primeira página).

### Extração do escopo de mensagens

O bloco de `getMessages` que calcula `conversationScope`, `historyScope` e
`scopes` (`leads.service.ts` ~2130–2190) vira
`buildMessageScope(lead, user, tenantCfg, me, ownedInstances): Prisma.MessageWhereInput | null`
num arquivo próprio `lead-message-scope.ts`, com o retorno `null`
significando "sem acesso a nenhuma mensagem". `getMessages`, `timeline` e
`media` chamam a mesma função. Os specs existentes de `getMessages`
(`leads-messages-individual.spec.ts`, `leads-messages-ad.spec.ts`) precisam
continuar verdes sem alteração de expectativa — é a prova de que a extração
não mudou comportamento.

### Escrita

Nenhum endpoint de escrita novo. A ficha usa:

- `PATCH /api/leads/:id` — nome, telefone, email, temperatura, valor_estimado,
  empresa, cargo, tags, dados_custom.
- `PATCH /api/leads/:id/stage` — etapa.
- `POST /api/leads/:id/claim | /reassign | /return-to-pool | /move-to-sector`.
- `POST /api/messages/internal-note` — `{ lead_id, content, mentioned_user_ids? }`.

Cada gravação bem-sucedida invalida `['lead', id]`, `['lead-timeline', id]` e,
quando aplicável, `['chat','leads']` e `['lead-activities', id]`.

## Frontend

Rota: `apps/web/src/app/(dashboard)/leads/[id]/page.tsx`. A lista atual em
`leads/page.tsx` não muda de rota.

Componentes novos (todos em `apps/web/src/components/leads/`):

- `inline-field.tsx` — `InlineField` com variantes `text`, `phone`, `email`,
  `currency`, `select`. Estados: leitura (mostra valor ou placeholder
  "Adicionar…"), edição, salvando, erro. Enter/blur salvam; Esc cancela; valor
  igual não dispara PATCH. Erro da API aparece abaixo do campo e o valor volta
  ao anterior. Aceita `disabled` (visualizador). Sem dependência de tabela —
  pronto para ser reusado nas células da lista numa rodada futura.
- `lead-header.tsx` — cabeçalho da coluna esquerda.
- `lead-fields.tsx` — campos fixos + `FieldGroupList` + `LeadContactsBlock`.
- `lead-timeline.tsx` — busca paginada (`useInfiniteQuery`,
  `['lead-timeline', id]`), filtros, "Carregar mais", estado vazio por filtro.
- `timeline-item.tsx` — um renderizador por `tipo`. Sessão: ícone de conversa,
  "14 mensagens · 14:02–14:40", prévia, link "abrir no chat" para
  `/chat/[id]`. O chat de hoje só rola até o fim (`bottomRef`), não tem
  âncora por mensagem; a âncora `?msg=` fica como follow-up fora desta rodada. Nota: balão
  amarelo igual ao chat, autor, menções destacadas. Atividade: reaproveita a
  formatação de `components/kanban/activity-timeline.tsx` (extrair a função
  de rótulo/ícone por `subtipo` para `lib/activity-label.ts` e usar nos dois).
  Tarefa e lembrete: ícone próprio, status como badge.
- `lead-media-grid.tsx` — aba Mídia.
- `nota-interna-composer.tsx` (em `components/chat/`) — **novo componente**; a
  resolução de `@menção` saiu da página do chat para `lib/mentions.ts` e as
  duas telas a importam (o chat continua usando o toggle de nota do
  `ChatComposer`).

Atualização ao vivo: a página assina `message:new`, `lead:updated`,
`lead:stage-changed` e `lead:new-message` (helper de socket existente em
`lib/socket.ts`) filtrando pelo `lead_id`, e invalida `['lead-timeline', id]`
e `['lead', id]`. Nota criada pela própria página faz update otimista da
timeline.

Pontos de entrada:

- Drawer do kanban: link "Abrir ficha completa" no cabeçalho; aba Mídia passa
  a mostrar "A galeria está na ficha do lead" com o mesmo link.
- Sheet do chat: mesmo link.
- Lista de leads: o nome vira link para a ficha (clique com Ctrl abre em nova
  aba); o comportamento atual de abrir o drawer continua no resto da linha.
- Ctrl+K: sem mudança.

## Permissões (resumo por papel)

| papel | vê a página | edita campos | escreve nota | vê mídia |
|---|---|---|---|---|
| VISUALIZADOR | leads que o recorte de lista lhe mostra | não | não | sim (recorte de mensagens) |
| OPERADOR | leads dele ou das instâncias que atende; privado só se dono | sim | sim | sim |
| GERENTE / ADMIN | todos do tenant; em modo foco, regra do foco no chat vale para mensagens | sim | sim | sim |

Sem acesso ao lead: API 404; a página mostra "Lead não encontrado ou fora do
seu alcance" com botão de voltar. A UI **não** é a barreira: os endpoints
recusam por conta própria. Sem acesso: 403 (privado de outro, operador fora)
ou 404 (outro tenant); a página trata os dois igual.

## Tratamento de erro

- Timeline falha: bloco com "Não foi possível carregar a atividade" e botão
  tentar de novo; o resto da página continua usável.
- PATCH recusado (validação, 403): erro inline no campo, valor restaurado.
- Nota falha: texto volta para a caixa, toast de erro.
- Lead arquivado/excluído durante a visita: `lead:updated` com `arquivado`
  redireciona para `/leads` com toast.

## Testes

API:

- `lead-timeline.spec.ts` (helper puro): fronteira exata de 30 min (29:59 é
  mesma sessão, 30:01 abre outra), uma mensagem sozinha, sessão fechada à
  força em 500, contagem enviadas/recebidas, prévia de mídia.
- `leads-timeline.spec.ts` (service, Prisma mockado): operador sem acesso → 404;
  privado de outro → 404; visualizador lê; mesclagem ordena por `quando`;
  `nextCursor` correto; tarefa concluída gera dois itens; notas não entram em
  sessão.
- `leads-media.spec.ts`: filtra tipos; respeita `buildMessageScope`.
- Specs existentes de `getMessages` intactos após a extração do escopo.
- `leads.roles.spec.ts`: as duas rotas novas com papel mínimo VISUALIZADOR.

Web (jest só roda `src/lib/**/*.spec.ts`, ambiente node — não há runner de
componente):

- `mentions.spec.ts`, `activity-label.spec.ts`, `lead-timeline-view.spec.ts`,
  `inline-field-state.spec.ts`.
- Componentes (`InlineField`, `LeadTimeline`, `TimelineItemView`,
  `NotaInternaComposer`, `LeadMediaGrid`, página) são verificados por `tsc`,
  `eslint` e conferência manual no navegador.

Rodar sempre `npx jest --maxWorkers=2` (16 GB de RAM nesta máquina).

## Fora desta rodada (registrar no ledger)

- Limpar drawer e sheet para virarem resumo curto (hoje 722 + 147 linhas).
- Edição inline nas células da lista de leads (item 4 da rodada Twenty) —
  reaproveita `InlineField`.
- Agregação por coluna no kanban (item 5) e workflows visuais (item 6).
- Filtro por tipo no servidor (`?tipos=`), se a timeline pesar.
- Âncora de mensagem no chat, caso não exista.
- Painel de estatísticas de verdade (tempo de resposta, mensagens por dia) —
  a aba "Estatísticas" do drawer nunca foi isso.

## Runbook de deploy

Sem migração. Backend primeiro (VPS `/opt/crm-whatsapp`, ssh.exe do Windows),
front pela Vercel no push. Janela front-novo/backend-velho: a página cai no
404 do endpoint de timeline e mostra o bloco de erro; não corrompe nada.
