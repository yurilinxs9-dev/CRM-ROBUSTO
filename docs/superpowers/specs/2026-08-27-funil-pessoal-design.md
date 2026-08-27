# Funil pessoal por operador — Design

Pedido do Yuri (27/08, após liberar gestão de etapas p/ operador): cada operador toca a própria carteira; o CRM deve suportar OS DOIS formatos — funil compartilhado do time E funil pessoal de cada operador. Decisões ratificadas por ele:
1. **Roteamento:** lead novo atribuído a um operador (rodízio, claim do pool, reassign, criação manual com responsável) cai na 1ª etapa do funil pessoal do operador, se ele tiver um; sem funil pessoal, cai no funil padrão do tenant (comportamento atual).
2. **Visibilidade:** funil pessoal aparece só para o dono + gerente/admin. Operador vê os compartilhados + o seu.

## Modelo

- `Pipeline.owner_user_id String?` (null = compartilhado — todo funil existente continua como está). FK → User com ON DELETE SET NULL (dono excluído ⇒ funil vira compartilhado, nada some).
- Nenhuma mudança em Stage/Lead: o funil pessoal é um pipeline comum com dono. Radar, dashboard, financeira e views já filtram por pipeline — herdam tudo.

## Regras

- **Criação:** operador pode criar funil — SEMPRE com `owner_user_id` = ele mesmo (forçado no backend, ignora o que vier no body). Gerente/admin criam compartilhado (default) ou pessoal de qualquer membro (campo `owner_user_id` opcional no body).
- **Listagem (GET /pipelines e tudo que deriva):** não-gestor recebe `owner_user_id IS NULL OR owner_user_id = eu`. Gestor recebe tudo. Isso propaga sozinho para os seletores do kanban/radar/leads/dashboard.
- **Edição/exclusão de funil:** dono do funil pessoal pode renomear/excluir/arquivar O SEU (delete-with-move incluso); funis compartilhados continuam GERENTE. Etapas dentro de qualquer funil visível seguem as regras de hoje (operador: criar/excluir/nome/cor/reordenar).
- **Roteamento na atribuição:** no momento em que o lead ganha responsável novo (claim, round-robin, reassign, criação com responsável), se o responsável tem funil pessoal (o mais antigo, se houver vários) e o lead NÃO está já nele: mover para a 1ª etapa (menor `ordem`, não-won/lost) do funil pessoal, com `LeadActivity` (tipo `funil_pessoal`, descricao humana) + WebSocket + invalidação de cache — reaproveitando `updateStage`/caminhos existentes onde couber.
- **Nunca mover de volta sozinho:** tirar o responsável ou reatribuir a alguém sem funil pessoal NÃO move o lead (fica onde está; gestor decide).
- Follow-up/broadcasts, SLA e automações não mudam (operam por etapa/lead, indiferentes ao dono do funil).

## UI

- Dialog de criar funil: para gerente, select "Funil de:" (Compartilhado + lista de membros ativos); para operador, cria direto como pessoal dele (texto explicando).
- Seletor de funis: badge/sufixo "· pessoal" (e para gestor, "· Isamara") nos funis com dono.
- Ajuda (`/ajuda`): parágrafo novo na seção Kanban explicando os dois formatos.

## Fora de escopo (deliberado)

- Etapas por usuário dentro do mesmo funil (quebraria relatórios/radar/financeira — rejeitado no design).
- Migração automática de leads existentes para funis pessoais (gestor move na mão se quiser).
- Limite de funis pessoais por operador (sem limite; cap natural = bom senso, revisitar se virar bagunça).
