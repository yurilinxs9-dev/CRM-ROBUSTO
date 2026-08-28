# Modo individual redondo — design

Data: 2026-08-28. Aprovado pelo Yuri ("o que achar melhor pode seguir").

## Contexto

O modo de carteira já existe por tenant (`Tenant.pool_enabled`: true = Compartilhado,
false = Individual), com switch em Ajustes e escolha no signup (`account_model`).
`buildVisibilityWhere` (lead-visibility.ts) já corta o kanban do membro no modo
individual, e `returnToPool`/`claim`/`reassign` já existem no `LeadsService`.

Cinco lacunas reais foram identificadas com o Yuri; esta spec cobre a Fase 1.
Fase 2 (round-robin configurável com pesos por colaborador) terá spec própria.

## Decisões do Yuri (28/08)

- Admin do tenant decide o modo (já é assim via `pool_enabled`).
- No individual, membro comum perde: kanban dos colegas E conversas de outras
  instâncias no chat.
- Lead novo sem dono: só admin/gerente vê e distribui (manual ou round-robin).
- Lead DEVOLVIDO cai na "nuvem": visível para qualquer um pegar.
- Modo foco é pessoal: cada admin/gerente liga o seu.
- Troca de modo em Ajustes exige aviso; a opção também existe na criação da
  conta (signup já tem — conferir que segue exposta).
- Gerente vê o trabalho dos membros "de forma organizada": seletor Ver como.

## 1. Chat cortado no modo individual

No individual (`pool_enabled=false`), o dono comum (OPERADOR/VISUALIZADOR) do
card deixa de receber `conversationScope = null` em `getMessages`
(leads.service.ts:1652). Passa a ver só as conversas dele
(`ownConversationIds` + mensagens legadas da própria instância — ramo
transitório existente). Gerente/SUPER_ADMIN **sem** modo foco segue vendo tudo.
No Compartilhado nada muda (dono segue vendo a conversa inteira).

O mesmo corte vale para qualquer caminho paralelo que monte escopo de mensagens
(ex.: `messages.service.ts:175` no envio) — auditar e alinhar.

## 2. Modo foco (pessoal, por admin/gerente)

- Schema: `User.focus_mode Boolean @default(false)`.
- Efeito (só relevante para GERENTE/SUPER_ADMIN de tenant; ignora platform
  admin): visibilidade de kanban, lista e chat passa a ser a de operador —
  só leads onde é `responsavel_id` — **mais** leads sem dono do tenant
  (novos e nuvem), porque distribuir é papel dele.
- Ações de distribuir/reatribuir continuam liberadas (RolesGuard não muda;
  focus_mode afeta SELECT, nunca permissão de escrita).
- `buildVisibilityWhere` ganha input `focusMode: boolean` e trata o caso
  manager+foco. Função continua pura e testável.
- UI: toggle "Modo foco" no menu do avatar (header do dashboard). Persiste
  via `PATCH /api/users/me` (ou endpoint equivalente existente); `/auth/me`
  devolve o campo; auth.store guarda.

## 3. Nuvem de devolvidos

- Schema: `Lead.returned_at DateTime?`.
- `returnToPool` carimba `returned_at = now()`; `claim`/`reassign`/atribuição
  manual/round-robin limpam (`null`).
- Visibilidade no individual: membro comum passa a ver TAMBÉM
  `{ responsavel_id: null, returned_at: { not: null }, is_private: false }`.
  Lead novo sem dono (`returned_at` null) segue invisível para membro.
- No Compartilhado a nuvem é irrelevante (pool já mostra todo sem-dono).
- UI: card sem dono com `returned_at` ganha selo "Disponível"; clique oferece
  o claim que já existe. Sem tela nova.

## 4. Aviso ao trocar o modo

Switch Individual/Compartilhado em Ajustes (GeneralTab) ganha dialog de
confirmação antes do PATCH:
- Indo para Compartilhado: "Membros passarão a ver todos os cards e conversas
  do tenant."
- Indo para Individual: "Membros deixarão de ver cards dos colegas e conversas
  de outras instâncias; leads sem dono ficam só com admin/gerente."
Cancelar não altera nada. Nenhuma migração de dados na troca.

## 5. Ver como membro (gerente)

- Kanban: seletor "Ver como: [membro]" visível só para GERENTE/SUPER_ADMIN
  (escondido em modo foco). Lista membros do tenant.
- Backend: filtro `responsavel_id` explícito na listagem de leads, aplicado
  como o `parseOwnerScope` das abas Meus/Escritório (sem mutar o `where` das
  contagens). Recusar o filtro para roles não-gerente (senão membro contorna
  o individual passando query param).

## Erros e bordas

- Lead privado (`is_private`) continua regra suprema: nem nuvem nem Ver como
  furam.
- Admin em foco que devolve o próprio lead: cai na nuvem como o de qualquer um.
- Cache da listagem (`buildLeadsListKey`) precisa incluir `focus_mode` e o
  filtro Ver como, senão serve board errado.
- WebSocket: devolver/pegar lead já emite eventos de Kanban (regra 8 do
  CLAUDE.md) — conferir que returnToPool/claim emitem.

## Testes

- `lead-visibility.spec.ts`: casos novos — manager+foco, membro vê nuvem,
  lead novo sem dono invisível p/ membro, privado nunca aparece.
- Spec do corte de chat no individual (getMessages): dono comum não vê conversa
  de outra instância; gerente sem foco vê; gerente com foco não vê.
- Spec returned_at: returnToPool carimba, claim/reassign limpam.
- Spec do filtro Ver como: role não-gerente recebe 403/ignora.

## Migração

Duas colunas (`User.focus_mode`, `Lead.returned_at`), aditivas, sem backfill.
Aplicar pelo ritual do banco poluído (CLAUDE.md): `prisma migrate diff` →
limpar drift alheio → aplicar em transação → `migrate resolve --applied`.
Sem janela de indisponibilidade (colunas novas, nullable/default).

## Fora de escopo (Fase 2)

Round-robin configurável: distribuir igual para todos vs peso por colaborador,
configurável em Ajustes. Spec própria quando a Fase 1 estiver no ar.
