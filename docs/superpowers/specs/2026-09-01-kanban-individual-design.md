# Kanban individual por membro — Design

Data: 2026-09-01. Status: aprovado pelo Yuri (conversa 01/09).

## Problema

Etapas (`Stage`) são compartilhadas pelo tenant. Qualquer membro que cria/edita
coluna muda o kanban de todo mundo. Caso real: na Cajuru Interiores, a Isamara
(OPERADOR) criou 9 colunas em 27/08 e os demais membros não gostaram.

## Decisões (com o Yuri)

1. **Kanban 100% independente por membro** quando o recurso está ativo: cada
   membro tem seu conjunto completo de colunas. (Alternativas "só colunas
   próprias" e "overlay de preferências" foram descartadas pelo Yuri.)
2. Gerente/admin: board próprio + seletor **"Ver como membro"** (já existe)
   para abrir o board de qualquer membro como ele vê. Sem visão agregada nova.
3. Liga/desliga por tenant, em Ajustes.

## Modelo de dados

- `Tenant.kanban_individual Boolean @default(false)` — toggle.
- `Stage.user_id String?` + relação `User` (onDelete: Cascade não; usar
  `SetNull` e tratar órfã como coluna base) —
  - `null` = coluna do **modelo base** do tenant (template; invisível no kanban
    quando o toggle está ON);
  - preenchido = coluna pessoal daquele membro.
- Índice novo: `@@index([tenant_id, user_id])`.
- Migration pelo fluxo do CLAUDE.md (`migrate diff` + aplicar manual +
  `migrate resolve`; NUNCA `migrate deploy`/`db push`). Colunas aditivas, sem
  backfill obrigatório.

## Comportamento

### Toggle OFF (default — nada muda)
Tudo como hoje: todas as etapas do tenant têm `user_id null` e são
compartilhadas.

### Ativação (OFF → ON)
1. Conjunto atual de colunas compartilhadas vira o **modelo base** (continua
   `user_id null`).
2. Para cada membro ativo do tenant: clona o modelo base como conjunto pessoal
   (copia nome, cor, ordem, is_won/is_lost, sla/idle/response/on_entry/cadence
   configs, auto_action, campos_obrigatorios, max_dias, probabilidade).
3. Leads remapeiam `estagio_id` para a cópia do seu `responsavel_id` (mesma
   etapa de origem). Lead sem responsável mantém a coluna base.
4. Emite WebSocket de kanban atualizado (regra 8 do CLAUDE.md).

### Com o toggle ON
- GET de pipelines/etapas para o kanban devolve só as colunas do usuário
  (`user_id = viewer`).
- **"Ver como membro" hoje é só filtro `responsavel_id` nos leads** (kanban
  page → query). Precisa de complemento: o GET de pipelines/etapas aceita
  `view_as_user_id` (validado: só GERENTE/SUPER_ADMIN) e devolve as colunas do
  membro alvo; o kanban page passa o mesmo id nos dois requests.
- Criar/renomear/recolorir/reordenar/apagar etapa: só nas colunas próprias.
  Ninguém (nem OPERADOR criativo) toca nas colunas dos outros.
- Permissões dentro da coluna própria: OPERADOR controla estrutura (criar,
  apagar, nome, cor, ordem). Campos avançados (is_won/is_lost, sla, cadence,
  auto_action, on_entry, campos_obrigatorios, max_dias, probabilidade) seguem
  só GERENTE/SUPER_ADMIN, como hoje (`CAMPOS_STAGE_OPERADOR`); vêm herdados do
  clone.
- **Lead inbound novo**: com responsável (round robin/atribuição) → primeira
  coluna do responsável; sem responsável → primeira coluna base.
- Tela de etapas do admin (config do pipeline) edita o **modelo base** —
  serve de template para membro novo.
- Membro novo criado com toggle ON: recebe clone do modelo base na criação.
- **Claim/reassign/atribuição**: lead vai para a coluna do novo dono com o
  mesmo nome (case-insensitive); sem equivalente → primeira coluna do novo
  dono (ordem 0).
- **Nuvem** (`responsavel_id null`, `returned_at` preenchido): lead mantém o
  `estagio_id` de onde estava. Na renderização do kanban de quem olha, o card
  da nuvem aparece na coluna de mesmo nome do viewer; sem equivalente →
  primeira coluna. Só apresentação; o remap real acontece no claim.
- Dashboards/métricas: `is_won`/`is_lost` existem nas colunas pessoais, então
  taxa de ganho etc. seguem por lead/responsável. Agrupamentos por etapa viram
  por-membro — aceito na decisão de kanban 100% independente.

### Desativação (ON → OFF)
1. Leads remapeiam para a coluna **base** de mesmo nome; sem equivalente →
   primeira coluna base.
2. Colunas pessoais (agora vazias) são apagadas. Referências penduradas:
   `LeadInsight.etapa_sugerida_id` já é `onDelete: SetNull`;
   `Broadcast.stage_id` (string solta, sem FK) apontando para coluna pessoal
   apagada → anular no mesmo passo.
3. Kanban volta a ser o modelo base compartilhado para todos.

### Guardas
- Toggle: só ADMIN/GERENTE (mesma régua dos demais ajustes do tenant).
- Ativar/desativar são operações em transação (remap + clone atômicos).
- Confirmação com aviso na UI antes de ativar/desativar (padrão do modal de
  troca de modelo de atendimento, commit b87369d).

## Migração Cajuru (one-shot, script separado do deploy)

Tenant `bb4953ac-b37f-4445-81c0-f54508c77141`.

1. Modelo base = as **9 colunas originais** (criadas até 18/06): Novo,
   Em contato, Qualificado, Ganho, Perdido, Aguardando orçamento, Retorno para
   cliente, SEM RETORNO, Empresa / Representantes.
2. As **9 colunas da Isamara** (criadas 27/08: Aguardando Projeto, Atendimento
   Presencial, Visitar a Loja, "Em Contato" duplicada, Leds, Instagram,
   Arquiteta, Finalizado, Vendedores Loja) recebem `user_id = Isamara`
   (`dc416756-a583-447b-9e62-cc63e132bf00`).
3. Isamara também recebe clone das 9 antigas, preservando a ordem atual do
   board (18 colunas no total). Leads dela remapeiam para as colunas dela.
4. Alex, Brendo, Jessyca, Lucas e o admin (Cajuru Interiores): clone das 9
   originais; leads deles remapeiam para as próprias cópias, mesma etapa.
   **Resultado: board deles idêntico ao pré-27/08.**
5. ~5 leads de outros membros presos em colunas da Isamara: "Em Contato"
   (dup) → "Em contato" do dono; Visitar a Loja / Finalizado / Vendedores
   Loja → "Em contato" do dono (sem equivalente antigo). Aprovado pelo Yuri.
6. Liga `kanban_individual` no tenant.

Limitações aceitas:
- Sem histórico no banco; se a Isamara tiver renomeado colunas antigas não há
  como recuperar o nome anterior. Evidência atual: ela só adicionou colunas —
  as 9 antigas estão intactas.
- Views salvas (`LeadView.filtros`) que filtram por id de etapa apontariam
  para colunas base esvaziadas após a ativação. Cajuru tem zero views salvas
  (verificado 01/09) — sem impacto; limitação documentada para outros tenants.

## Testes

- `pipelines.service.spec.ts`: scoping por `user_id` no toggle ON; clone na
  ativação; remap na desativação; membro só edita coluna própria; membro novo
  recebe clone.
- `leads` specs: claim/reassign remapeiam por nome + fallback primeira coluna;
  nuvem renderiza no board do viewer.
- Script Cajuru: dry-run imprime o plano (contagens por coluna) antes de
  aplicar; rodar em transação.

## Fora de escopo

- Visão agregada para gerente (descartada).
- Compartilhar colunas entre subconjuntos de membros.
- Histórico/undo de edições de coluna.
