# Ficha do lead unificada com timeline — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `/leads/[id]` com campos editáveis inline, Ficha 360, galeria de mídia e uma timeline única (sessões de conversa, notas internas, tarefas, lembretes da IA, atividades), alimentada por dois endpoints novos de leitura.

**Architecture:** O recorte de visibilidade de mensagens sai de `getMessages` para uma função pura reutilizada por três endpoints. Um `LeadTimelineService` novo (arquivo próprio, `leads.service.ts` já tem 2.200 linhas) mescla cinco fontes ordenadas por data com cursor ISO. No front, toda lógica testável vive em `src/lib/*.ts` (o jest do web só roda `lib/*.spec.ts`, ambiente node, sem runner de componente); os componentes ficam finos.

**Tech Stack:** NestJS 10 + Prisma + Zod (API); Next.js 14 App Router + TanStack Query + shadcn/ui + Tailwind + socket.io-client (web); jest + ts-jest nos dois.

Spec: `docs/superpowers/specs/2026-09-02-ficha-lead-timeline-design.md`.

## Global Constraints

- NUNCA `any` no TypeScript de produção (specs podem usar `any` nos mocks, padrão do repo).
- SEMPRE validar input com Zod (query/body dos endpoints novos).
- Nenhuma migração de banco nesta rodada. Nenhum endpoint de escrita novo.
- Papel mínimo dos endpoints novos: `VISUALIZADOR` (leitura). Escrita de nota segue a regra de `createInternalNote` (VISUALIZADOR recusado, OPERADOR só no lead que é dele).
- Corte de sessão: `SESSAO_GAP_MS = 30 * 60_000`. Teto: 500 mensagens por sessão (`truncada: true` acima disso). `limit` padrão 40, máximo 100.
- Jest local: sempre `npx jest --maxWorkers=2` (16 GB de RAM). Rodar de `apps/api` ou `apps/web`.
- Testes do web: só funções puras em `apps/web/src/lib/**/*.spec.ts` (jest.config.js do web: `testRegex: 'lib/.*\\.spec\\.ts$'`, `testEnvironment: 'node'`). Componentes não têm teste automatizado; a verificação deles é `npx tsc --noEmit` + `npx eslint` + conferência manual.
- Idioma: identificadores e textos de UI em português sem acento nos identificadores (padrão do repo: `agruparSessoes`, `naNuvem`), textos exibidos com acento.
- Commits pequenos, mensagem em português no formato `feat(api): ...` / `feat(web): ...` / `refactor(...)` / `test(...)`.
- Branch de trabalho: `feat/ficha-lead-timeline` a partir de `master` (`fb25441` ou posterior).

## Mapa de arquivos

API (`apps/api/src/modules/leads/`):

| arquivo | responsabilidade |
|---|---|
| `lead-message-scope.ts` (novo) | função pura `buildMessageScope` + `isSupervising`: o recorte de visibilidade de mensagens de um lead para um usuário |
| `lead-message-scope.spec.ts` (novo) | prova a extração: mesmos `where` que `getMessages` produzia |
| `leads.service.ts` (modificar) | `getMessages` passa a usar `buildMessageScope`; ganha `messageScopeFor(lead, user)` público, usado pela timeline e pela mídia |
| `lead-timeline.ts` (novo) | tipos `TimelineItem` e helpers puros `agruparSessoes`, `previewDaMensagem`, `mesclarTimeline` |
| `lead-timeline.spec.ts` (novo) | testes dos helpers |
| `lead-timeline.service.ts` (novo) | `LeadTimelineService.getTimeline` e `.getMedia` (Prisma + `LeadsService.findOne` como gate) |
| `lead-timeline.service.spec.ts` (novo) | testes do service com Prisma mockado |
| `leads.controller.ts` (modificar) | rotas `GET :id/timeline` e `GET :id/media` |
| `leads.module.ts` (modificar) | registra `LeadTimelineService` |
| `leads.roles.spec.ts` (modificar) | as duas rotas com `@Roles(VISUALIZADOR)` |

Web (`apps/web/src/`):

| arquivo | responsabilidade |
|---|---|
| `lib/mentions.ts` (novo) + spec | `normalizeName`, `extractMentionIds` (saem da página do chat) |
| `lib/activity-label.ts` (novo) + spec | rótulo por `tipo` de `LeadActivity` (sai de `activity-timeline.tsx`) |
| `lib/lead-timeline-view.ts` (novo) + spec | tipos do item da timeline, `filtrarPorCategoria`, `categoriaDoItem`, `rotuloSessao`, `rotuloMidia`, `agruparPorDia` |
| `lib/inline-field-state.ts` (novo) + spec | regras de commit do campo inline (`decidirCommit`, normalização por variante) |
| `components/leads/inline-field.tsx` (novo) | `InlineField` (text, phone, email, currency, select) |
| `components/leads/lead-header.tsx` (novo) | cabeçalho da coluna esquerda |
| `components/leads/lead-fields.tsx` (novo) | campos fixos + `FieldGroupList` + `LeadContactsBlock` |
| `components/leads/lead-timeline.tsx` (novo) | busca paginada, filtros, lista |
| `components/leads/timeline-item.tsx` (novo) | um renderizador por tipo |
| `components/leads/lead-media-grid.tsx` (novo) | aba Mídia |
| `components/chat/nota-interna-composer.tsx` (novo) | caixa de nota com `@` (usa `lib/mentions`) |
| `app/(dashboard)/leads/[id]/page.tsx` (novo) | a página |
| `app/(dashboard)/chat/[id]/page.tsx` (modificar) | importa `extractMentionIds` de `lib/mentions` |
| `components/kanban/activity-timeline.tsx` (modificar) | importa rótulo de `lib/activity-label` |
| `components/kanban/lead-detail-drawer.tsx` (modificar) | link "Abrir ficha completa"; aba Mídia aponta para a ficha |
| `components/chat/lead-details-sheet.tsx` (modificar) | link "Abrir ficha completa" |
| `components/leads/lead-table.tsx` (modificar) | nome vira link para a ficha |

---

### Task 0: Branch

**Files:** nenhum.

- [ ] **Step 1: Criar a branch a partir da master atualizada**

```bash
cd /c/Users/yurid/CRM-ROBUSTO
git checkout master && git pull --ff-only
git checkout -b feat/ficha-lead-timeline
```

- [ ] **Step 2: Confirmar que a suíte da API está verde antes de mexer**

```bash
cd apps/api && npx jest --maxWorkers=2 --silent 2>&1 | tail -5
```

Expected: `Tests: N passed` sem falhas (N era 1123+ em 01/09).

---

### Task 1: Extrair o recorte de mensagens (`buildMessageScope`)

**Files:**
- Create: `apps/api/src/modules/leads/lead-message-scope.ts`
- Create: `apps/api/src/modules/leads/lead-message-scope.spec.ts`
- Modify: `apps/api/src/modules/leads/leads.service.ts:2095-2200` (`getMessages`)

**Interfaces:**
- Produces:
  ```ts
  export interface MessageScopeLead { responsavel_id: string | null; instancia_whatsapp: string | null; assumed_at: Date | null; is_private: boolean }
  export interface MessageScopeCtx { userId: string; role: string; focusMode: boolean; shareHistoryEnabled: boolean; poolEnabled: boolean; ownConversationIds: string[]; ownedInstances: string[] }
  export function isManagerRoleName(role: string): boolean
  export function isSupervising(lead: MessageScopeLead, role: string, focusMode: boolean): boolean
  /** null = sem acesso a nenhuma mensagem; {} = sem corte; {AND:[...]} = cortes */
  export function buildMessageScope(lead: MessageScopeLead, ctx: MessageScopeCtx): Prisma.MessageWhereInput | null
  ```
  e em `LeadsService`: `async messageScopeFor(lead: MessageScopeLead & { id: string }, user: AuthUser): Promise<Prisma.MessageWhereInput | null>`.

- [ ] **Step 1: Escrever o spec da função pura**

`apps/api/src/modules/leads/lead-message-scope.spec.ts`:

```ts
import { buildMessageScope, isSupervising } from './lead-message-scope';
import type { MessageScopeCtx, MessageScopeLead } from './lead-message-scope';

const lead = (over: Partial<MessageScopeLead> = {}): MessageScopeLead => ({
  responsavel_id: 'u-dono',
  instancia_whatsapp: 'inst-A',
  assumed_at: null,
  is_private: false,
  ...over,
});

const ctx = (over: Partial<MessageScopeCtx> = {}): MessageScopeCtx => ({
  userId: 'u-dono',
  role: 'OPERADOR',
  focusMode: false,
  shareHistoryEnabled: false,
  poolEnabled: false,
  ownConversationIds: ['conv-1'],
  ownedInstances: ['inst-A'],
  ...over,
});

describe('isSupervising', () => {
  it('gerente sem foco supervisiona', () => {
    expect(isSupervising(lead(), 'GERENTE', false)).toBe(true);
  });
  it('gerente em foco NAO supervisiona lead com dono', () => {
    expect(isSupervising(lead(), 'GERENTE', true)).toBe(false);
  });
  it('gerente em foco supervisiona lead sem dono', () => {
    expect(isSupervising(lead({ responsavel_id: null }), 'GERENTE', true)).toBe(true);
  });
  it('operador nunca supervisiona', () => {
    expect(isSupervising(lead(), 'OPERADOR', false)).toBe(false);
  });
});

describe('buildMessageScope', () => {
  it('lead privado de outro devolve null', () => {
    expect(buildMessageScope(lead({ is_private: true }), ctx({ userId: 'u-outro' }))).toBeNull();
  });
  it('gerente supervisionando: sem corte ({}), mesmo com assumed_at', () => {
    expect(
      buildMessageScope(lead({ assumed_at: new Date('2026-01-01') }), ctx({ role: 'GERENTE' })),
    ).toEqual({});
  });
  it('operador sem conversa, sem ser dono e sem a instancia devolve null', () => {
    expect(
      buildMessageScope(
        lead({ responsavel_id: 'u-x', instancia_whatsapp: 'inst-Z' }),
        ctx({ ownConversationIds: [], ownedInstances: ['inst-A'] }),
      ),
    ).toBeNull();
  });
  it('dono no modo individual recebe corte por conversa', () => {
    const where = buildMessageScope(lead(), ctx());
    expect(where?.AND).toEqual([
      {
        OR: [
          { conversation_id: { in: ['conv-1'] } },
          { conversation_id: null, instance_name: { in: ['inst-A'] } },
        ],
      },
    ]);
  });
  it('dono com pool ligado nao tem corte por conversa', () => {
    expect(buildMessageScope(lead(), ctx({ poolEnabled: true }))).toEqual({});
  });
  it('operador com assumed_at e sem share_history recebe corte de historico', () => {
    const assumed = new Date('2026-08-01T00:00:00Z');
    const where = buildMessageScope(lead({ assumed_at: assumed }), ctx());
    expect(where?.AND).toContainEqual({
      OR: [{ created_at: { gte: assumed } }, { visible_to_user_id: 'u-dono' }],
    });
  });
  it('share_history_enabled desliga o corte de historico', () => {
    const where = buildMessageScope(
      lead({ assumed_at: new Date('2026-08-01') }),
      ctx({ shareHistoryEnabled: true }),
    );
    expect(where?.AND).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/lead-message-scope.spec.ts
```

Expected: FAIL — `Cannot find module './lead-message-scope'`.

- [ ] **Step 3: Criar a função pura**

`apps/api/src/modules/leads/lead-message-scope.ts`:

```ts
import type { Prisma } from '@prisma/client';

/**
 * Recorte de visibilidade das mensagens de um lead para um usuário. Era o
 * miolo de `LeadsService.getMessages`; extraído para que timeline e galeria de
 * mídia apliquem EXATAMENTE a mesma regra do chat. Sem Prisma aqui: quem chama
 * resolve conversas e instâncias próprias antes (só quando não supervisiona).
 */
export interface MessageScopeLead {
  responsavel_id: string | null;
  instancia_whatsapp: string | null;
  assumed_at: Date | null;
  is_private: boolean;
}

export interface MessageScopeCtx {
  userId: string;
  role: string;
  focusMode: boolean;
  shareHistoryEnabled: boolean;
  poolEnabled: boolean;
  ownConversationIds: string[];
  ownedInstances: string[];
}

const MANAGER_ROLES = new Set(['GERENTE', 'SUPER_ADMIN']);

export function isManagerRoleName(role: string): boolean {
  return MANAGER_ROLES.has(role);
}

/**
 * Gerente sem foco vê tudo. Gerente focado abre mão da visão total — MENOS em
 * lead sem dono, onde ler a conversa é o insumo da distribuição.
 */
export function isSupervising(lead: MessageScopeLead, role: string, focusMode: boolean): boolean {
  return isManagerRoleName(role) && (!focusMode || lead.responsavel_id === null);
}

/**
 * `null` = nenhuma mensagem visível. `{}` = visão total. `{ AND: [...] }` =
 * cortes por conversa e/ou por histórico anterior ao claim.
 */
export function buildMessageScope(
  lead: MessageScopeLead,
  ctx: MessageScopeCtx,
): Prisma.MessageWhereInput | null {
  // Lead privado: só o responsável atual lê. Nem outros gerentes.
  if (lead.is_private && lead.responsavel_id !== ctx.userId) return null;

  const isManager = isManagerRoleName(ctx.role);
  const isResponsavel = lead.responsavel_id === ctx.userId;
  const supervising = isSupervising(lead, ctx.role, ctx.focusMode);

  if (!supervising) {
    const accessibleByInstance =
      !!lead.instancia_whatsapp && ctx.ownedInstances.includes(lead.instancia_whatsapp);
    if (ctx.ownConversationIds.length === 0 && !isResponsavel && !accessibleByInstance) {
      return null;
    }
  }

  // Histórico antes do claim só é escondido de OPERADOR; tenant com
  // share_history_enabled desliga o corte.
  const hideHistory = !isManager && !!lead.assumed_at && !ctx.shareHistoryEnabled;

  const conversationScope: Prisma.MessageWhereInput | null =
    supervising || (isResponsavel && ctx.poolEnabled)
      ? null
      : {
          OR: [
            { conversation_id: { in: ctx.ownConversationIds } },
            { conversation_id: null, instance_name: { in: ctx.ownedInstances } },
          ],
        };
  const historyScope: Prisma.MessageWhereInput | null = hideHistory
    ? {
        OR: [
          { created_at: { gte: lead.assumed_at as Date } },
          { visible_to_user_id: ctx.userId },
        ],
      }
    : null;
  const scopes = [conversationScope, historyScope].filter(
    (scope): scope is Prisma.MessageWhereInput => scope !== null,
  );
  return scopes.length ? { AND: scopes } : {};
}
```

- [ ] **Step 4: Rodar o spec novo**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/lead-message-scope.spec.ts
```

Expected: PASS (11 testes).

- [ ] **Step 5: Refatorar `getMessages` para usar a função e expor `messageScopeFor`**

Em `leads.service.ts`, adicionar o import no topo junto dos outros do módulo:

```ts
import { buildMessageScope, isSupervising } from './lead-message-scope';
import type { MessageScopeLead } from './lead-message-scope';
```

Adicionar o método público logo ANTES de `getMessages`:

```ts
  /**
   * Recorte de mensagens do lead para o usuário (`null` = nada visível). Usado
   * por getMessages, pela timeline e pela galeria — uma regra só.
   */
  async messageScopeFor(
    lead: MessageScopeLead & { id: string },
    user: AuthUser,
  ): Promise<Prisma.MessageWhereInput | null> {
    const [tenantCfg, me] = await Promise.all([
      this.prisma.tenant.findFirst({
        where: { id: user.tenantId },
        select: { share_history_enabled: true, pool_enabled: true },
      }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { focus_mode: true },
      }),
    ]);
    const focusMode = Boolean(me?.focus_mode);
    let ownConversationIds: string[] = [];
    let ownedInstances: string[] = [];
    if (!isSupervising(lead, user.role, focusMode)) {
      ownedInstances = await this.getOwnedInstanceNames(user.id, user.tenantId);
      ownConversationIds = (
        await this.prisma.conversation.findMany({
          where: { lead_id: lead.id, responsavel_id: user.id },
          select: { id: true },
        })
      ).map((c) => c.id);
    }
    return buildMessageScope(lead, {
      userId: user.id,
      role: user.role,
      focusMode,
      shareHistoryEnabled: Boolean(tenantCfg?.share_history_enabled),
      poolEnabled: Boolean(tenantCfg?.pool_enabled),
      ownConversationIds,
      ownedInstances,
    });
  }
```

Substituir o corpo de `getMessages` do `if (!lead) throw ...` até o `const rows = await this.prisma.message.findMany({` por:

```ts
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    const scope = await this.messageScopeFor(lead, user);
    if (scope === null) return { messages: [], nextCursor: undefined };
    const rows = await this.prisma.message.findMany({
      where: {
        lead_id: leadId,
        tenant_id: user.tenantId,
        ...scope,
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
```

Manter o resto (hasMore, resolveMediaUrl, extractAdReferral, return). Os comentários longos sobre privacidade, foco e transição de `conversation_id` mudam de casa: mover para `lead-message-scope.ts` (já estão resumidos lá) e apagar as cópias de `getMessages`. Se `roleHierarchy` deixar de ser usado em `getMessages`, ele continua usado na linha ~1695, então não remover.

- [ ] **Step 6: Rodar os specs existentes de mensagens sem mudar nenhuma expectativa**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/leads-messages-individual.spec.ts src/modules/leads/leads-messages-ad.spec.ts src/modules/leads/lead-message-scope.spec.ts
```

Expected: PASS em todos. Se algum falhar por ORDEM de chamadas mockadas (o spec de `individual` lê `prisma.message.findMany.mock.calls[0][0].where`), a extração mudou comportamento: corrigir a função, nunca o spec.

- [ ] **Step 7: tsc e commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../.. && git add apps/api/src/modules/leads/lead-message-scope.ts apps/api/src/modules/leads/lead-message-scope.spec.ts apps/api/src/modules/leads/leads.service.ts && git commit -m "refactor(api): recorte de mensagens do lead extraido para buildMessageScope"
```

---

### Task 2: Helpers puros da timeline (`lead-timeline.ts`)

**Files:**
- Create: `apps/api/src/modules/leads/lead-timeline.ts`
- Create: `apps/api/src/modules/leads/lead-timeline.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SESSAO_GAP_MS = 30 * 60_000;
  export const SESSAO_MAX_MENSAGENS = 500;
  export interface MensagemParaSessao { id: string; created_at: Date; direction: 'INCOMING' | 'OUTGOING'; type: string; content: string | null; instance_name: string }
  export interface SessaoItem { tipo: 'sessao'; id: string; quando: string; inicio: string; fim: string; total: number; recebidas: number; enviadas: number; ultima_direcao: 'INCOMING' | 'OUTGOING'; preview: string; instancia: string; primeira_mensagem_id: string; truncada: boolean }
  export interface NotaItem { tipo: 'nota'; id: string; quando: string; conteudo: string; autor: { id: string; nome: string } | null; mencoes: { id: string; nome: string }[] }
  export interface AtividadeItem { tipo: 'atividade'; id: string; quando: string; subtipo: string; descricao: string; dados_antes: unknown; dados_depois: unknown; autor: { id: string; nome: string } | null }
  export interface TarefaItem { tipo: 'tarefa'; id: string; quando: string; evento: 'criada' | 'concluida'; titulo: string; tipo_tarefa: string; status: string; scheduled_at: string; completed_at: string | null; responsavel: { id: string; nome: string } | null }
  export interface LembreteItem { tipo: 'lembrete'; id: string; quando: string; motivo: string; avisar_em: string; status: string; origem: string }
  export type TimelineItem = SessaoItem | NotaItem | AtividadeItem | TarefaItem | LembreteItem;
  export function previewDaMensagem(m: Pick<MensagemParaSessao, 'type' | 'content'>): string
  /** entrada: desc por created_at (mais nova primeiro). saída: sessões desc por `fim`. */
  export function agruparSessoes(mensagens: MensagemParaSessao[], gapMs?: number): SessaoItem[]
  /** true se a mensagem `proxima` (mais antiga) ainda pertence à sessão da `atual` */
  export function mesmaSessao(atual: Date, proxima: Date, gapMs?: number): boolean
  export function mesclarTimeline(fontes: TimelineItem[][], limit: number, algumaFonteTemMais: boolean): { items: TimelineItem[]; nextCursor?: string }
  ```

- [ ] **Step 1: Escrever o spec**

`apps/api/src/modules/leads/lead-timeline.spec.ts`:

```ts
import {
  agruparSessoes,
  mesclarTimeline,
  mesmaSessao,
  previewDaMensagem,
  SESSAO_GAP_MS,
  SESSAO_MAX_MENSAGENS,
  type MensagemParaSessao,
  type TimelineItem,
} from './lead-timeline';

const t0 = Date.parse('2026-09-01T12:00:00.000Z');
const min = (n: number) => new Date(t0 + n * 60_000);

function msg(over: Partial<MensagemParaSessao> & { at: Date }): MensagemParaSessao {
  return {
    id: `m-${over.at.getTime()}`,
    created_at: over.at,
    direction: over.direction ?? 'INCOMING',
    type: over.type ?? 'TEXT',
    content: over.content ?? 'oi',
    instance_name: over.instance_name ?? 'inst-A',
  };
}

describe('previewDaMensagem', () => {
  it('texto vem cortado em 140 chars', () => {
    expect(previewDaMensagem({ type: 'TEXT', content: 'a'.repeat(200) })).toHaveLength(140);
  });
  it('midia vira rotulo entre colchetes', () => {
    expect(previewDaMensagem({ type: 'IMAGE', content: null })).toBe('[Imagem]');
    expect(previewDaMensagem({ type: 'AUDIO', content: null })).toBe('[Áudio]');
    expect(previewDaMensagem({ type: 'DOCUMENT', content: 'x.pdf' })).toBe('[Documento] x.pdf');
  });
});

describe('mesmaSessao', () => {
  it('29:59 e a mesma sessao, 30:01 nao', () => {
    const atual = min(60);
    expect(mesmaSessao(atual, new Date(atual.getTime() - SESSAO_GAP_MS + 1000))).toBe(true);
    expect(mesmaSessao(atual, new Date(atual.getTime() - SESSAO_GAP_MS - 1000))).toBe(false);
  });
});

describe('agruparSessoes', () => {
  it('uma mensagem sozinha vira uma sessao de 1', () => {
    const [s] = agruparSessoes([msg({ at: min(0) })]);
    expect(s.total).toBe(1);
    expect(s.inicio).toBe(s.fim);
    expect(s.primeira_mensagem_id).toBe('m-' + min(0).getTime());
  });

  it('separa por gap de 30 min e conta direcoes', () => {
    // entrada desc: 70, 65 (sessao B) | 20, 10, 0 (sessao A)
    const entrada = [
      msg({ at: min(70), direction: 'OUTGOING', content: 'fechado, mando o pix' }),
      msg({ at: min(65) }),
      msg({ at: min(20) }),
      msg({ at: min(10), direction: 'OUTGOING' }),
      msg({ at: min(0) }),
    ];
    const sessoes = agruparSessoes(entrada);
    expect(sessoes).toHaveLength(2);
    expect(sessoes[0].fim).toBe(min(70).toISOString());
    expect(sessoes[0].quando).toBe(min(70).toISOString());
    expect(sessoes[0].total).toBe(2);
    expect(sessoes[0].preview).toBe('fechado, mando o pix');
    expect(sessoes[0].ultima_direcao).toBe('OUTGOING');
    expect(sessoes[1].inicio).toBe(min(0).toISOString());
    expect(sessoes[1].fim).toBe(min(20).toISOString());
    expect(sessoes[1].recebidas).toBe(2);
    expect(sessoes[1].enviadas).toBe(1);
    expect(sessoes[1].primeira_mensagem_id).toBe('m-' + min(0).getTime());
  });

  it('fecha a forca em SESSAO_MAX_MENSAGENS e marca truncada', () => {
    const entrada = Array.from({ length: SESSAO_MAX_MENSAGENS + 5 }, (_, i) =>
      msg({ at: new Date(t0 + i * 1000) }),
    ).reverse();
    const sessoes = agruparSessoes(entrada);
    expect(sessoes[0].total).toBe(SESSAO_MAX_MENSAGENS);
    expect(sessoes[0].truncada).toBe(true);
    expect(sessoes[1].total).toBe(5);
  });
});

describe('mesclarTimeline', () => {
  const item = (tipo: TimelineItem['tipo'], quando: string): TimelineItem =>
    ({ tipo, id: `${tipo}-${quando}`, quando } as unknown as TimelineItem);

  it('ordena desc por quando entre fontes e corta em limit', () => {
    const r = mesclarTimeline(
      [
        [item('sessao', '2026-09-01T10:00:00.000Z')],
        [item('nota', '2026-09-01T11:00:00.000Z'), item('nota', '2026-09-01T09:00:00.000Z')],
      ],
      2,
      false,
    );
    expect(r.items.map((i) => i.quando)).toEqual([
      '2026-09-01T11:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
    ]);
    expect(r.nextCursor).toBe('2026-09-01T10:00:00.000Z');
  });

  it('sem sobra e sem fonte com mais, nextCursor e undefined', () => {
    const r = mesclarTimeline([[item('nota', '2026-09-01T11:00:00.000Z')]], 10, false);
    expect(r.nextCursor).toBeUndefined();
  });

  it('alguma fonte com mais forca nextCursor mesmo sem sobra local', () => {
    const r = mesclarTimeline([[item('nota', '2026-09-01T11:00:00.000Z')]], 10, true);
    expect(r.nextCursor).toBe('2026-09-01T11:00:00.000Z');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/lead-timeline.spec.ts
```

Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`apps/api/src/modules/leads/lead-timeline.ts`:

```ts
/**
 * Helpers puros da timeline do lead. Sem Prisma: recebem linhas já lidas e
 * devolvem os itens que a página consome. Ver spec
 * docs/superpowers/specs/2026-09-02-ficha-lead-timeline-design.md.
 */
export const SESSAO_GAP_MS = 30 * 60_000;
export const SESSAO_MAX_MENSAGENS = 500;
export const PREVIEW_MAX = 140;

export type Direcao = 'INCOMING' | 'OUTGOING';

export interface MensagemParaSessao {
  id: string;
  created_at: Date;
  direction: Direcao;
  type: string;
  content: string | null;
  instance_name: string;
}

export interface SessaoItem {
  tipo: 'sessao';
  id: string;
  quando: string;
  inicio: string;
  fim: string;
  total: number;
  recebidas: number;
  enviadas: number;
  ultima_direcao: Direcao;
  preview: string;
  instancia: string;
  primeira_mensagem_id: string;
  truncada: boolean;
}

export interface Pessoa {
  id: string;
  nome: string;
}

export interface NotaItem {
  tipo: 'nota';
  id: string;
  quando: string;
  conteudo: string;
  autor: Pessoa | null;
  mencoes: Pessoa[];
}

export interface AtividadeItem {
  tipo: 'atividade';
  id: string;
  quando: string;
  subtipo: string;
  descricao: string;
  dados_antes: unknown;
  dados_depois: unknown;
  autor: Pessoa | null;
}

export interface TarefaItem {
  tipo: 'tarefa';
  id: string;
  quando: string;
  evento: 'criada' | 'concluida';
  titulo: string;
  tipo_tarefa: string;
  status: string;
  scheduled_at: string;
  completed_at: string | null;
  responsavel: Pessoa | null;
}

export interface LembreteItem {
  tipo: 'lembrete';
  id: string;
  quando: string;
  motivo: string;
  avisar_em: string;
  status: string;
  origem: string;
}

export type TimelineItem = SessaoItem | NotaItem | AtividadeItem | TarefaItem | LembreteItem;

const ROTULO_MIDIA: Record<string, string> = {
  IMAGE: '[Imagem]',
  VIDEO: '[Vídeo]',
  AUDIO: '[Áudio]',
  DOCUMENT: '[Documento]',
  STICKER: '[Figurinha]',
  LOCATION: '[Localização]',
  CONTACT: '[Contato]',
};

export function previewDaMensagem(m: Pick<MensagemParaSessao, 'type' | 'content'>): string {
  const texto = (m.content ?? '').trim();
  const rotulo = ROTULO_MIDIA[m.type.toUpperCase()];
  if (rotulo) return texto ? `${rotulo} ${texto}`.slice(0, PREVIEW_MAX) : rotulo;
  return texto.slice(0, PREVIEW_MAX);
}

/** `proxima` é a mensagem mais ANTIGA (a lista chega desc). */
export function mesmaSessao(atual: Date, proxima: Date, gapMs = SESSAO_GAP_MS): boolean {
  return atual.getTime() - proxima.getTime() <= gapMs;
}

/**
 * Entrada desc (mais nova primeiro). Cada sessão nasce na mensagem mais nova
 * do bloco e cresce para trás até o gap ou o teto. `quando` = `fim`, para a
 * sessão ordenar junto dos outros itens pela última mensagem.
 */
export function agruparSessoes(
  mensagens: MensagemParaSessao[],
  gapMs = SESSAO_GAP_MS,
): SessaoItem[] {
  const sessoes: SessaoItem[] = [];
  let bloco: MensagemParaSessao[] = [];

  const fechar = (truncada: boolean) => {
    if (bloco.length === 0) return;
    const ultima = bloco[0];
    const primeira = bloco[bloco.length - 1];
    sessoes.push({
      tipo: 'sessao',
      id: `sessao-${primeira.id}`,
      quando: ultima.created_at.toISOString(),
      inicio: primeira.created_at.toISOString(),
      fim: ultima.created_at.toISOString(),
      total: bloco.length,
      recebidas: bloco.filter((m) => m.direction === 'INCOMING').length,
      enviadas: bloco.filter((m) => m.direction === 'OUTGOING').length,
      ultima_direcao: ultima.direction,
      preview: previewDaMensagem(ultima),
      instancia: ultima.instance_name,
      primeira_mensagem_id: primeira.id,
      truncada,
    });
    bloco = [];
  };

  for (const m of mensagens) {
    if (bloco.length === 0) {
      bloco.push(m);
      continue;
    }
    const anterior = bloco[bloco.length - 1];
    if (bloco.length >= SESSAO_MAX_MENSAGENS) {
      fechar(true);
      bloco.push(m);
      continue;
    }
    if (mesmaSessao(anterior.created_at, m.created_at, gapMs)) {
      bloco.push(m);
    } else {
      fechar(false);
      bloco.push(m);
    }
  }
  fechar(false);
  return sessoes;
}

export function mesclarTimeline(
  fontes: TimelineItem[][],
  limit: number,
  algumaFonteTemMais: boolean,
): { items: TimelineItem[]; nextCursor?: string } {
  const todos = fontes.flat().sort((a, b) => (a.quando < b.quando ? 1 : a.quando > b.quando ? -1 : 0));
  const items = todos.slice(0, limit);
  const sobrou = todos.length > limit;
  const nextCursor =
    items.length > 0 && (sobrou || algumaFonteTemMais) ? items[items.length - 1].quando : undefined;
  return { items, nextCursor };
}
```

- [ ] **Step 4: Rodar o spec**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/lead-timeline.spec.ts
```

Expected: PASS (9 testes). Se o teste "fecha a forca" falhar no `total` da segunda sessão, conferir que o `fechar(true)` acontece ANTES de empurrar a mensagem 501.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/leads/lead-timeline.ts apps/api/src/modules/leads/lead-timeline.spec.ts && git commit -m "feat(api): helpers puros da timeline do lead (sessoes, preview, mescla)"
```

---

### Task 3: `LeadTimelineService.getTimeline` + rota `GET /leads/:id/timeline`

**AJUSTES PÓS-TASK 2 (valem sobre qualquer trecho abaixo que diga o contrário):** a revisão da Task 2 mudou o contrato do cursor. Ler `lead-timeline.ts` antes de codar; o que está lá governa.

- O cursor é opaco para o cliente: string `quando|id|mensagensAntes?` (`codificarCursor` / `decodificarCursor` / tipo `TimelineCursor` exportados por `lead-timeline.ts`). `timelineQuerySchema.cursor` vira `z.string().optional()`; o service decodifica e lança `BadRequestException('cursor invalido')` se `decodificarCursor` devolver `null`.
- Fontes por data (notas, atividades, tarefas, lembretes): consultar com `created_at <= cursor.quando` (INCLUSIVO, `lte`), não `lt`. Tarefas: `OR: [{ created_at: { lte } }, { completed_at: { lte } }]` e as condições por item também com `<=`. O desempate por `(quando, id)` é feito em memória por `mesclarTimeline(fontes, limit, algumaFonteTemMais, cursor)` — passar o cursor decodificado como 4º argumento.
- Fonte de mensagens (sessões): quando `cursor.mensagensAntes` existe, consultar com `created_at < new Date(cursor.mensagensAntes)` (ESTRITO); quando não existe, sem limite superior. NÃO usar `cursor.quando` para mensagens.
- `nextCursor` sai pronto de `mesclarTimeline` (já codificado). O service não monta cursor.
- O spec do service muda de acordo: o teste "cursor entra como created_at < cursor" passa a verificar `lte` nas fontes por data e `lt` com `mensagensAntes` nas mensagens; o teste de `nextCursor` compara com `codificarCursor({...})` do último item. Cursor de entrada nos testes: usar `codificarCursor`.
- A sessão parcial no fim da lista de mensagens é fechada pelo loop de `LOTE_FECHAMENTO` deste service (já previsto); manter.

**Files:**
- Create: `apps/api/src/modules/leads/lead-timeline.service.ts`
- Create: `apps/api/src/modules/leads/lead-timeline.service.spec.ts`
- Modify: `apps/api/src/modules/leads/leads.controller.ts` (nova rota depois de `getActivities`, linha ~108)
- Modify: `apps/api/src/modules/leads/leads.module.ts` (providers)
- Modify: `apps/api/src/modules/leads/leads.roles.spec.ts` (novo describe)

**Interfaces:**
- Consumes: `LeadsService.findOne(id, user)` (lança `NotFoundException` se não é do tenant, `ForbiddenException` se privado de outro ou operador/visualizador sem acesso); `LeadsService.messageScopeFor(lead, user)` (Task 1); `agruparSessoes`, `mesclarTimeline`, `mesmaSessao`, tipos (Task 2).
- Produces:
  ```ts
  export const timelineQuerySchema = z.object({ cursor: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) });
  @Injectable() export class LeadTimelineService {
    getTimeline(leadId: string, user: AuthUser, q: { cursor?: string; limit: number }): Promise<{ items: TimelineItem[]; nextCursor?: string }>
  }
  ```
  Rota: `GET /api/leads/:id/timeline?cursor=&limit=` devolve esse objeto. Sem acesso: 403 (privado de outro, operador fora) ou 404 (outro tenant). A página trata os dois igual.

- [ ] **Step 1: Escrever o spec do service**

`apps/api/src/modules/leads/lead-timeline.service.spec.ts`:

```ts
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LeadTimelineService } from './lead-timeline.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000004';
const T = (iso: string) => new Date(iso);

const user = (role: UserRole, id = 'u-1'): AuthUser => ({
  id,
  nome: id,
  email: `${id}@x.com`,
  role: role as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
});

type Fontes = {
  mensagens?: unknown[];
  notas?: unknown[];
  atividades?: unknown[];
  tarefas?: unknown[];
  lembretes?: unknown[];
  scope?: Record<string, unknown> | null;
  findOne?: () => Promise<unknown>;
};

function make(f: Fontes = {}) {
  const prisma: any = {
    message: {
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.is_internal_note === true ? (f.notas ?? []) : (f.mensagens ?? [])),
      ),
    },
    leadActivity: { findMany: jest.fn().mockResolvedValue(f.atividades ?? []) },
    task: { findMany: jest.fn().mockResolvedValue(f.tarefas ?? []) },
    leadLembrete: { findMany: jest.fn().mockResolvedValue(f.lembretes ?? []) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u-2', nome: 'Isamara' }]) },
  };
  const leads: any = {
    findOne: jest.fn().mockImplementation(
      f.findOne ??
        (() =>
          Promise.resolve({
            id: LEAD_ID,
            responsavel_id: 'u-1',
            instancia_whatsapp: 'inst-A',
            assumed_at: null,
            is_private: false,
          })),
    ),
    messageScopeFor: jest.fn().mockResolvedValue(f.scope === undefined ? {} : f.scope),
    resolveMediaUrl: jest
      .fn()
      .mockImplementation((u: string | null) => Promise.resolve(u ? `signed:${u}` : null)),
  };
  return { service: new LeadTimelineService(prisma, leads), prisma, leads };
}

describe('LeadTimelineService.getTimeline — acesso', () => {
  it('lead de outro tenant: findOne lanca 404 e a timeline propaga', async () => {
    const { service } = make({ findOne: () => Promise.reject(new NotFoundException()) });
    await expect(
      service.getTimeline(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('operador sem acesso: findOne lanca 403 e a timeline propaga', async () => {
    const { service } = make({ findOne: () => Promise.reject(new ForbiddenException()) });
    await expect(
      service.getTimeline(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('scope null: nenhuma mensagem nem nota, mas atividades continuam', async () => {
    const { service, prisma } = make({
      scope: null,
      atividades: [
        {
          id: 'a1', tipo: 'stage_change', descricao: 'x', dados_antes: null, dados_depois: null,
          created_at: T('2026-09-01T10:00:00Z'), user: null,
        },
      ],
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.VISUALIZADOR), { limit: 40 });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(r.items.map((i) => i.tipo)).toEqual(['atividade']);
  });
});

describe('LeadTimelineService.getTimeline — mescla', () => {
  it('ordena por quando, notas fora das sessoes, tarefa concluida gera 2 itens', async () => {
    const { service } = make({
      mensagens: [
        { id: 'm2', created_at: T('2026-09-01T12:10:00Z'), direction: 'OUTGOING', type: 'TEXT', content: 'ok', instance_name: 'inst-A' },
        { id: 'm1', created_at: T('2026-09-01T12:00:00Z'), direction: 'INCOMING', type: 'TEXT', content: 'oi', instance_name: 'inst-A' },
      ],
      notas: [
        { id: 'n1', created_at: T('2026-09-01T12:05:00Z'), content: 'cliente quer @Isamara', sent_by: { id: 'u-1', nome: 'Yuri' }, metadata: { mentions: ['u-2'] } },
      ],
      tarefas: [
        { id: 't1', titulo: 'Ligar', tipo: 'LIGACAO', status: 'CONCLUIDA', scheduled_at: T('2026-09-01T09:00:00Z'), completed_at: T('2026-09-01T13:00:00Z'), created_at: T('2026-09-01T08:00:00Z'), responsavel: { id: 'u-1', nome: 'Yuri' } },
      ],
      lembretes: [
        { id: 'l1', motivo: 'pediu retorno', avisar_em: T('2026-09-03T09:00:00Z'), status: 'pendente', origem: 'ia', created_at: T('2026-09-01T12:20:00Z') },
      ],
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 40 });
    expect(r.items.map((i) => `${i.tipo}:${i.quando}`)).toEqual([
      'tarefa:2026-09-01T13:00:00.000Z',
      'lembrete:2026-09-01T12:20:00.000Z',
      'sessao:2026-09-01T12:10:00.000Z',
      'nota:2026-09-01T12:05:00.000Z',
      'tarefa:2026-09-01T08:00:00.000Z',
    ]);
    const sessao = r.items.find((i) => i.tipo === 'sessao');
    expect(sessao && sessao.tipo === 'sessao' && sessao.total).toBe(2);
    const nota = r.items.find((i) => i.tipo === 'nota');
    expect(nota && nota.tipo === 'nota' && nota.mencoes).toEqual([{ id: 'u-2', nome: 'Isamara' }]);
    expect(r.nextCursor).toBeUndefined();
  });

  it('cursor entra como created_at < cursor nas fontes por data', async () => {
    const { service, prisma } = make();
    await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), {
      cursor: '2026-09-01T12:00:00.000Z',
      limit: 10,
    });
    const lt = new Date('2026-09-01T12:00:00.000Z');
    expect(prisma.leadActivity.findMany.mock.calls[0][0].where.created_at).toEqual({ lt });
    expect(prisma.leadLembrete.findMany.mock.calls[0][0].where.created_at).toEqual({ lt });
    expect(prisma.message.findMany.mock.calls[0][0].where.created_at).toEqual({ lt });
    expect(prisma.task.findMany.mock.calls[0][0].where.OR).toEqual([
      { created_at: { lt } },
      { completed_at: { lt } },
    ]);
  });

  it('nextCursor aparece quando alguma fonte devolveu limit+1', async () => {
    const atividades = Array.from({ length: 3 }, (_, i) => ({
      id: `a${i}`, tipo: 'lead_updated', descricao: '', dados_antes: null, dados_depois: null,
      created_at: T(`2026-09-01T1${i}:00:00Z`), user: null,
    }));
    const { service } = make({ atividades });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBe('2026-09-01T11:00:00.000Z');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/lead-timeline.service.spec.ts
```

Expected: FAIL com módulo não encontrado.

- [ ] **Step 3: Implementar o service**

`apps/api/src/modules/leads/lead-timeline.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { LeadsService } from './leads.service';
import {
  agruparSessoes,
  mesclarTimeline,
  mesmaSessao,
  SESSAO_MAX_MENSAGENS,
  type AtividadeItem,
  type LembreteItem,
  type MensagemParaSessao,
  type NotaItem,
  type Pessoa,
  type TarefaItem,
  type TimelineItem,
} from './lead-timeline';

export const timelineQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** Lote extra lido para fechar a sessão cortada pela paginação. */
const LOTE_FECHAMENTO = 50;

interface Fonte {
  items: TimelineItem[];
  temMais: boolean;
}
const VAZIA: Fonte = { items: [], temMais: false };

/**
 * Timeline única do lead: sessões de conversa, notas internas, atividades,
 * tarefas e lembretes. Cinco fontes lidas em paralelo com `created_at < cursor`,
 * mescladas e cortadas em `limit`. Gate de acesso = `LeadsService.findOne`
 * (mesma regra da ficha); recorte de mensagens = o do chat (`messageScopeFor`).
 */
@Injectable()
export class LeadTimelineService {
  constructor(
    private prisma: PrismaService,
    private leads: LeadsService,
  ) {}

  async getTimeline(leadId: string, user: AuthUser, q: TimelineQuery) {
    const lead = await this.leads.findOne(leadId, user);
    const cursorDate = q.cursor ? new Date(q.cursor) : undefined;
    const scope = await this.leads.messageScopeFor(
      {
        id: lead.id,
        responsavel_id: lead.responsavel_id,
        instancia_whatsapp: lead.instancia_whatsapp,
        assumed_at: lead.assumed_at,
        is_private: lead.is_private,
      },
      user,
    );

    const fontes = await Promise.all([
      scope === null ? VAZIA : this.sessoes(leadId, user, scope, cursorDate, q.limit),
      scope === null ? VAZIA : this.notas(leadId, user, scope, cursorDate, q.limit),
      this.atividades(leadId, user, cursorDate, q.limit),
      this.tarefas(leadId, user, cursorDate, q.limit),
      this.lembretes(leadId, user, cursorDate, q.limit),
    ]);
    return mesclarTimeline(
      fontes.map((f) => f.items),
      q.limit,
      fontes.some((f) => f.temMais),
    );
  }

  private antesDe(cursorDate?: Date): { created_at: Prisma.DateTimeFilter } | Record<string, never> {
    return cursorDate ? { created_at: { lt: cursorDate } } : {};
  }

  private baseMensagem(
    leadId: string,
    user: AuthUser,
    scope: Prisma.MessageWhereInput,
    cursorDate?: Date,
  ): Prisma.MessageWhereInput {
    return {
      lead_id: leadId,
      tenant_id: user.tenantId,
      ...this.antesDe(cursorDate),
      ...scope,
    };
  }

  private async sessoes(
    leadId: string,
    user: AuthUser,
    scope: Prisma.MessageWhereInput,
    cursorDate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const select = {
      id: true, created_at: true, direction: true, type: true, content: true, instance_name: true,
    } as const;
    const where: Prisma.MessageWhereInput = {
      ...this.baseMensagem(leadId, user, scope, cursorDate),
      is_internal_note: false,
    };
    let rows: MensagemParaSessao[] = await this.prisma.message.findMany({
      where,
      select,
      orderBy: { created_at: 'desc' },
      take: limit + 1,
    });
    const temMais = rows.length > limit;
    // Fecha a última sessão: enquanto a mensagem seguinte (mais antiga) ainda
    // estiver a menos de 30 min da última lida, continua lendo, até o teto.
    let lidas = 0;
    while (rows.length > 0 && temMais && lidas < SESSAO_MAX_MENSAGENS) {
      const ultima = rows[rows.length - 1];
      const proximas: MensagemParaSessao[] = await this.prisma.message.findMany({
        where: { ...where, created_at: { lt: ultima.created_at } },
        select,
        orderBy: { created_at: 'desc' },
        take: LOTE_FECHAMENTO,
      });
      if (proximas.length === 0) break;
      const corte = proximas.findIndex((m, i) => {
        const anterior = i === 0 ? ultima : proximas[i - 1];
        return !mesmaSessao(anterior.created_at, m.created_at);
      });
      const pertencem = corte === -1 ? proximas : proximas.slice(0, corte);
      rows = rows.concat(pertencem);
      lidas += pertencem.length;
      if (corte !== -1) break;
    }
    return { items: agruparSessoes(rows), temMais };
  }

  private async notas(
    leadId: string,
    user: AuthUser,
    scope: Prisma.MessageWhereInput,
    cursorDate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const rows = await this.prisma.message.findMany({
      where: { ...this.baseMensagem(leadId, user, scope, cursorDate), is_internal_note: true },
      select: {
        id: true,
        created_at: true,
        content: true,
        metadata: true,
        sent_by: { select: { id: true, nome: true } },
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
    });
    const temMais = rows.length > limit;
    const usadas = temMais ? rows.slice(0, limit) : rows;
    const idsMencionados = new Set<string>();
    for (const r of usadas) for (const id of mentionsDe(r.metadata)) idsMencionados.add(id);
    const pessoas: Pessoa[] = idsMencionados.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...idsMencionados] }, tenant_id: user.tenantId },
          select: { id: true, nome: true },
        })
      : [];
    const porId = new Map(pessoas.map((p) => [p.id, p]));
    const items: NotaItem[] = usadas.map((r) => ({
      tipo: 'nota',
      id: r.id,
      quando: r.created_at.toISOString(),
      conteudo: r.content ?? '',
      autor: r.sent_by ?? null,
      mencoes: mentionsDe(r.metadata)
        .map((id) => porId.get(id))
        .filter((p): p is Pessoa => !!p),
    }));
    return { items, temMais };
  }

  private async atividades(
    leadId: string,
    user: AuthUser,
    cursorDate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const rows = await this.prisma.leadActivity.findMany({
      where: { lead_id: leadId, tenant_id: user.tenantId, ...this.antesDe(cursorDate) },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        tipo: true,
        descricao: true,
        dados_antes: true,
        dados_depois: true,
        created_at: true,
        user: { select: { id: true, nome: true } },
      },
    });
    const temMais = rows.length > limit;
    const items: AtividadeItem[] = (temMais ? rows.slice(0, limit) : rows).map((r) => ({
      tipo: 'atividade',
      id: r.id,
      quando: r.created_at.toISOString(),
      subtipo: r.tipo,
      descricao: r.descricao,
      dados_antes: r.dados_antes,
      dados_depois: r.dados_depois,
      autor: r.user ?? null,
    }));
    return { items, temMais };
  }

  private async tarefas(
    leadId: string,
    user: AuthUser,
    cursorDate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    // Tarefa entra duas vezes quando concluída (criação e conclusão); o
    // cursor vale por evento, então o where lê por created_at OU completed_at.
    const rows = await this.prisma.task.findMany({
      where: {
        lead_id: leadId,
        tenant_id: user.tenantId,
        ...(cursorDate
          ? { OR: [{ created_at: { lt: cursorDate } }, { completed_at: { lt: cursorDate } }] }
          : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        titulo: true,
        tipo: true,
        status: true,
        scheduled_at: true,
        completed_at: true,
        created_at: true,
        responsavel: { select: { id: true, nome: true } },
      },
    });
    const temMais = rows.length > limit;
    const items: TarefaItem[] = [];
    for (const r of temMais ? rows.slice(0, limit) : rows) {
      const base = {
        titulo: r.titulo,
        tipo_tarefa: r.tipo,
        status: r.status,
        scheduled_at: r.scheduled_at.toISOString(),
        completed_at: r.completed_at ? r.completed_at.toISOString() : null,
        responsavel: r.responsavel ?? null,
      };
      if (!cursorDate || r.created_at < cursorDate) {
        items.push({
          tipo: 'tarefa', id: `${r.id}:criada`, quando: r.created_at.toISOString(), evento: 'criada', ...base,
        });
      }
      if (r.completed_at && (!cursorDate || r.completed_at < cursorDate)) {
        items.push({
          tipo: 'tarefa', id: `${r.id}:concluida`, quando: r.completed_at.toISOString(), evento: 'concluida', ...base,
        });
      }
    }
    return { items, temMais };
  }

  private async lembretes(
    leadId: string,
    user: AuthUser,
    cursorDate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const rows = await this.prisma.leadLembrete.findMany({
      where: { lead_id: leadId, tenant_id: user.tenantId, ...this.antesDe(cursorDate) },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      select: { id: true, motivo: true, avisar_em: true, status: true, origem: true, created_at: true },
    });
    const temMais = rows.length > limit;
    const items: LembreteItem[] = (temMais ? rows.slice(0, limit) : rows).map((r) => ({
      tipo: 'lembrete',
      id: r.id,
      quando: r.created_at.toISOString(),
      motivo: r.motivo,
      avisar_em: r.avisar_em.toISOString(),
      status: r.status,
      origem: r.origem,
    }));
    return { items, temMais };
  }
}

/** `metadata.mentions` é gravado por createInternalNote como array de ids. */
function mentionsDe(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const m = (metadata as { mentions?: unknown }).mentions;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}
```

Se o tsc reclamar que `lead.assumed_at` de `findOne` tem tipo diferente de `Date | null` (o CLAUDE.md avisa de drift no tipo dessa coluna), converter: `assumed_at: lead.assumed_at ? new Date(lead.assumed_at) : null`.

- [ ] **Step 4: Rodar o spec**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/lead-timeline.service.spec.ts
```

Expected: PASS (6 testes).

- [ ] **Step 5: Registrar no módulo e expor a rota**

`leads.module.ts`: `import { LeadTimelineService } from './lead-timeline.service';` e acrescentar `LeadTimelineService` em `providers` (não precisa exportar).

`leads.controller.ts`: importar `LeadTimelineService, timelineQuerySchema` de `./lead-timeline.service`; construtor:

```ts
  constructor(
    private leadsService: LeadsService,
    private timeline: LeadTimelineService,
  ) {}
```

Depois de `getActivities`:

```ts
  // Ficha do lead: timeline única (sessões de conversa, notas, tarefas,
  // lembretes, atividades). Leitura — VISUALIZADOR passa; o service recusa
  // por lead (findOne) e recorta mensagens como o chat.
  @Get(':id/timeline')
  @Roles(UserRole.VISUALIZADOR)
  getTimeline(
    @Param('id') id: string,
    @Req() req: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    return this.timeline.getTimeline(id, req.user as AuthUser, timelineQuerySchema.parse(query));
  }
```

- [ ] **Step 6: Roles spec**

Acrescentar ao fim de `leads.roles.spec.ts`:

```ts
describe('LeadsController — rotas de leitura da ficha (VISUALIZADOR passa)', () => {
  const rotas = ['getTimeline'] as const; // Task 4 acrescenta 'getMedia'
  it.each(rotas)('%s declara @Roles(VISUALIZADOR)', (metodo) => {
    expect(Reflect.getMetadata(ROLES_KEY, handlerDe(metodo))).toEqual([UserRole.VISUALIZADOR]);
  });
  it.each([UserRole.VISUALIZADOR, UserRole.OPERADOR, UserRole.GERENTE, UserRole.SUPER_ADMIN])(
    '%s passa no guard da timeline',
    (role) => {
      expect(guard().canActivate(contextoDe('getTimeline', role))).toBe(true);
    },
  );
});
```

Conferir que nada instancia o controller com um argumento só:

```bash
grep -rn "new LeadsController(" apps/api/src
```

Expected: nenhuma ocorrência. Se houver, passar `{} as any` como segundo argumento.

- [ ] **Step 7: Rodar specs do módulo + tsc + commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && npx jest --maxWorkers=2 src/modules/leads && cd ../.. && git add apps/api/src/modules/leads && git commit -m "feat(api): GET /leads/:id/timeline — sessoes, notas, tarefas, lembretes e atividades mesclados"
```

Expected: tsc limpo; specs de `leads` verdes.

---

### Task 4: `getMedia` + rota `GET /leads/:id/media`

**Files:**
- Modify: `apps/api/src/modules/leads/lead-timeline.service.ts`
- Modify: `apps/api/src/modules/leads/lead-timeline.service.spec.ts`
- Modify: `apps/api/src/modules/leads/leads.controller.ts`
- Modify: `apps/api/src/modules/leads/leads.roles.spec.ts`
- Modify (talvez): `apps/api/src/modules/leads/leads.service.ts` (`resolveMediaUrl` de `private` para público)

**Interfaces:**
- Consumes: `LeadsService.resolveMediaUrl(path: string | null): Promise<string | null>` — hoje é `private` (`leads.service.ts:278`); trocar por `public` (só a palavra-chave).
- Produces:
  ```ts
  export const mediaQuerySchema = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) });
  export const TIPOS_MIDIA = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] as const;
  export interface MediaItem { id: string; type: string; media_url: string | null; media_mimetype: string | null; media_filename: string | null; media_thumbnail_path: string | null; media_duration_seconds: number | null; direction: 'INCOMING' | 'OUTGOING'; created_at: string }
  getMedia(leadId: string, user: AuthUser, q: MediaQuery): Promise<{ items: MediaItem[]; nextCursor?: string }>
  ```
  Rota `GET /api/leads/:id/media?cursor=<uuid>&limit=`.

- [ ] **Step 1: Spec**

Acrescentar em `lead-timeline.service.spec.ts` (o helper `make` já tem `resolveMediaUrl`):

```ts
describe('LeadTimelineService.getMedia', () => {
  const midia = (id: string) => ({
    id, type: 'IMAGE', media_url: `path/${id}.jpg`, media_mimetype: 'image/jpeg', media_filename: null,
    media_thumbnail_path: null, media_duration_seconds: null, direction: 'INCOMING',
    created_at: T('2026-09-01T12:00:00Z'),
  });

  it('filtra tipos de midia, exclui notas, aplica scope e assina URL', async () => {
    const { service, prisma } = make({
      mensagens: [midia('m1')],
      scope: { AND: [{ conversation_id: { in: ['c1'] } }] },
    });
    const r = await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    const where = prisma.message.findMany.mock.calls[0][0].where;
    expect(where.type).toEqual({ in: ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] });
    expect(where.is_internal_note).toBe(false);
    expect(where.AND).toEqual([{ conversation_id: { in: ['c1'] } }]);
    expect(r.items[0].media_url).toBe('signed:path/m1.jpg');
    expect(r.items[0].created_at).toBe('2026-09-01T12:00:00.000Z');
    expect(r.nextCursor).toBeUndefined();
  });

  it('scope null devolve vazio sem consultar', async () => {
    const { service, prisma } = make({ scope: null });
    const r = await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    expect(r.items).toEqual([]);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('cursor por id com skip 1 e nextCursor no limit+1', async () => {
    const { service, prisma } = make({ mensagens: [midia('m0'), midia('m1'), midia('m2')] });
    const r = await service.getMedia(LEAD_ID, user(UserRole.GERENTE), { cursor: 'm-prev', limit: 2 });
    const args = prisma.message.findMany.mock.calls[0][0];
    expect(args.cursor).toEqual({ id: 'm-prev' });
    expect(args.skip).toBe(1);
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBe('m1');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/api && npx jest --maxWorkers=2 src/modules/leads/lead-timeline.service.spec.ts -t getMedia
```

Expected: FAIL com `service.getMedia is not a function`.

- [ ] **Step 3: Implementar**

Em `lead-timeline.service.ts`, depois de `timelineQuerySchema`:

```ts
export const mediaQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type MediaQuery = z.infer<typeof mediaQuerySchema>;

export const TIPOS_MIDIA = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] as const;

export interface MediaItem {
  id: string;
  type: string;
  media_url: string | null;
  media_mimetype: string | null;
  media_filename: string | null;
  media_thumbnail_path: string | null;
  media_duration_seconds: number | null;
  direction: 'INCOMING' | 'OUTGOING';
  created_at: string;
}
```

Método na classe, depois de `getTimeline`:

```ts
  /** Galeria: mensagens de mídia do lead, no mesmo recorte do chat. */
  async getMedia(
    leadId: string,
    user: AuthUser,
    q: MediaQuery,
  ): Promise<{ items: MediaItem[]; nextCursor?: string }> {
    const lead = await this.leads.findOne(leadId, user);
    const scope = await this.leads.messageScopeFor(
      {
        id: lead.id,
        responsavel_id: lead.responsavel_id,
        instancia_whatsapp: lead.instancia_whatsapp,
        assumed_at: lead.assumed_at,
        is_private: lead.is_private,
      },
      user,
    );
    if (scope === null) return { items: [], nextCursor: undefined };
    const rows = await this.prisma.message.findMany({
      where: {
        ...this.baseMensagem(leadId, user, scope),
        is_internal_note: false,
        type: { in: [...TIPOS_MIDIA] },
      },
      select: {
        id: true,
        type: true,
        media_url: true,
        media_mimetype: true,
        media_filename: true,
        media_thumbnail_path: true,
        media_duration_seconds: true,
        direction: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const temMais = rows.length > q.limit;
    const usadas = temMais ? rows.slice(0, q.limit) : rows;
    const items: MediaItem[] = await Promise.all(
      usadas.map(async (r) => ({
        ...r,
        media_url: await this.leads.resolveMediaUrl(r.media_url),
        created_at: r.created_at.toISOString(),
      })),
    );
    return { items, nextCursor: temMais ? items[items.length - 1].id : undefined };
  }
```

Rota no controller, depois de `getTimeline` (importar também `mediaQuerySchema`):

```ts
  @Get(':id/media')
  @Roles(UserRole.VISUALIZADOR)
  getMedia(
    @Param('id') id: string,
    @Req() req: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    return this.timeline.getMedia(id, req.user as AuthUser, mediaQuerySchema.parse(query));
  }
```

Roles spec: trocar `['getTimeline'] as const` por `['getTimeline', 'getMedia'] as const`.

- [ ] **Step 4: Rodar, tsc, commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && npx jest --maxWorkers=2 src/modules/leads && cd ../.. && git add apps/api/src/modules/leads && git commit -m "feat(api): GET /leads/:id/media — galeria de midia no recorte do chat"
```

- [ ] **Step 5: Suíte inteira da API**

```bash
cd apps/api && npx jest --maxWorkers=2 --silent 2>&1 | tail -5
```

Expected: só passes. Fim do backend.

---

## Parte web

Convenções que valem para todas as tasks abaixo:

- Rodar de `apps/web`: `npx jest --maxWorkers=2` (só `src/lib/**/*.spec.ts`), `npx tsc --noEmit`, `npx eslint src`.
- `api` é o axios de `@/lib/api` (baseURL já configurada; caminhos começam com `/api/...`).
- Query keys: `['lead', id]` (ficha), `['lead-timeline', id]`, `['lead-media', id]`, `['lead-activities', id]`, `['users']`, `['pipelines', params]`, `['chat','leads']`, `['leads', ...]`.
- Papel do usuário: `useAuthStore((s) => s.user)` tem `role` (`'SUPER_ADMIN' | 'GERENTE' | 'OPERADOR' | 'VISUALIZADOR'`) e `id`. Gestor = `['GERENTE','SUPER_ADMIN'].includes(role)`.
- Componentes shadcn disponíveis em `@/components/ui`: avatar, badge, button, card, command, dialog, dropdown-menu, empty-state, input, label, popover, scroll-area, select, separator, sheet, skeleton, switch, tabs, textarea, tooltip.

---

### Task 5: `lib/mentions.ts` (extração da página do chat)

**Files:**
- Create: `apps/web/src/lib/mentions.ts`
- Create: `apps/web/src/lib/mentions.spec.ts`
- Modify: `apps/web/src/app/(dashboard)/chat/[id]/page.tsx:66-90` (apaga `normalizeName` e `extractMentionIds` locais; importa de `@/lib/mentions`)

**Interfaces:**
- Produces:
  ```ts
  export interface MencionavelUser { id: string; nome: string }
  export function normalizeName(s: string): string
  export function extractMentionIds(content: string, users: MencionavelUser[]): string[]
  /** sugestões para o autocomplete: usuários cujo nome normalizado começa com o trecho após o último '@' */
  export function sugerirMencoes(textoAteCursor: string, users: MencionavelUser[]): { termo: string; sugestoes: MencionavelUser[] } | null
  /** substitui o '@termo' em edição pelo '@Nome Completo ' */
  export function aplicarMencao(textoAteCursor: string, resto: string, user: MencionavelUser): { texto: string; cursor: number }
  ```

- [ ] **Step 1: Spec**

`apps/web/src/lib/mentions.spec.ts`:

```ts
import { aplicarMencao, extractMentionIds, normalizeName, sugerirMencoes } from './mentions';

const users = [
  { id: 'u1', nome: 'Isamara Souza' },
  { id: 'u2', nome: 'João Pedro' },
  { id: 'u3', nome: 'Ana' },
];

describe('normalizeName', () => {
  it('minusculas e sem acento', () => {
    expect(normalizeName('João Pédro')).toBe('joao pedro');
  });
});

describe('extractMentionIds', () => {
  it('casa @primeironome e @nome completo, sem acento', () => {
    expect(extractMentionIds('oi @joao e @isamara souza', users)).toEqual(['u1', 'u2']);
  });
  it('sem @ nao casa ninguem', () => {
    expect(extractMentionIds('isamara ligou', users)).toEqual([]);
  });
});

describe('sugerirMencoes', () => {
  it('null quando nao ha @ em edicao', () => {
    expect(sugerirMencoes('cliente pediu ', users)).toBeNull();
  });
  it('lista quem comeca com o termo apos o ultimo @', () => {
    const r = sugerirMencoes('avisa @is', users);
    expect(r?.termo).toBe('is');
    expect(r?.sugestoes.map((u) => u.id)).toEqual(['u1']);
  });
  it('@ sozinho lista todos', () => {
    expect(sugerirMencoes('avisa @', users)?.sugestoes).toHaveLength(3);
  });
  it('@ seguido de espaco encerra a edicao', () => {
    expect(sugerirMencoes('avisa @isamara souza ', users)).toBeNull();
  });
});

describe('aplicarMencao', () => {
  it('troca o termo pelo nome completo e devolve o cursor depois do espaco', () => {
    const r = aplicarMencao('avisa @is', ' por favor', users[0]);
    expect(r.texto).toBe('avisa @Isamara Souza  por favor');
    expect(r.cursor).toBe('avisa @Isamara Souza '.length);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/web && npx jest --maxWorkers=2 src/lib/mentions.spec.ts
```

Expected: FAIL, módulo não existe.

- [ ] **Step 3: Implementar**

`apps/web/src/lib/mentions.ts`:

```ts
/**
 * @menções em notas internas. Antes vivia dentro da página do chat; a ficha
 * do lead também escreve nota, então a regra mora aqui e as duas telas usam.
 */
export interface MencionavelUser {
  id: string;
  nome: string;
}

/** Minúsculas, sem acento — comparação de menção. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Casa `@primeironome` ou `@nome completo` (case/acento-insensitive). */
export function extractMentionIds(content: string, users: MencionavelUser[]): string[] {
  const normalized = normalizeName(content);
  const ids: string[] = [];
  for (const u of users) {
    const full = normalizeName(u.nome);
    const first = full.split(/\s+/)[0];
    if (normalized.includes(`@${full}`) || normalized.includes(`@${first}`)) ids.push(u.id);
  }
  return ids;
}

const EM_EDICAO = /@([^\s@]*)$/;

export function sugerirMencoes(
  textoAteCursor: string,
  users: MencionavelUser[],
): { termo: string; sugestoes: MencionavelUser[] } | null {
  const m = EM_EDICAO.exec(textoAteCursor);
  if (!m) return null;
  const termo = normalizeName(m[1]);
  const sugestoes = users.filter((u) => normalizeName(u.nome).startsWith(termo));
  return { termo, sugestoes };
}

export function aplicarMencao(
  textoAteCursor: string,
  resto: string,
  user: MencionavelUser,
): { texto: string; cursor: number } {
  const antes = textoAteCursor.replace(EM_EDICAO, '');
  const inserido = `${antes}@${user.nome} `;
  return { texto: `${inserido}${resto}`, cursor: inserido.length };
}
```

- [ ] **Step 4: Rodar o spec**

```bash
cd apps/web && npx jest --maxWorkers=2 src/lib/mentions.spec.ts
```

Expected: PASS (8 testes).

- [ ] **Step 5: Página do chat passa a importar**

Em `chat/[id]/page.tsx`: apagar as funções locais `normalizeName` (linhas ~66-71) e `extractMentionIds` (~73-90) e adicionar `import { extractMentionIds } from '@/lib/mentions';`. A chamada em `sendTextMutation` (`extractMentionIds(content, mentionableUsers ?? [])`) não muda.

- [ ] **Step 6: tsc + eslint + commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/lib/mentions.ts "src/app/(dashboard)/chat/[id]/page.tsx" && cd ../.. && git add apps/web/src/lib/mentions.ts apps/web/src/lib/mentions.spec.ts "apps/web/src/app/(dashboard)/chat/[id]/page.tsx" && git commit -m "refactor(web): @mencoes de nota interna extraidas para lib/mentions"
```

---

### Task 6: `lib/activity-label.ts` e `lib/lead-timeline-view.ts`

**Files:**
- Create: `apps/web/src/lib/activity-label.ts` + `activity-label.spec.ts`
- Create: `apps/web/src/lib/lead-timeline-view.ts` + `lead-timeline-view.spec.ts`
- Modify: `apps/web/src/components/kanban/activity-timeline.tsx:27-38` (usa `rotuloAtividade`)

**Interfaces:**
- Produces (`activity-label.ts`):
  ```ts
  export function rotuloAtividade(tipo: string): string
  ```
- Produces (`lead-timeline-view.ts`) — espelho dos tipos da API (Task 2) mais helpers de tela:
  ```ts
  export type Direcao = 'INCOMING' | 'OUTGOING';
  export interface Pessoa { id: string; nome: string }
  export interface SessaoItem { tipo: 'sessao'; id: string; quando: string; inicio: string; fim: string; total: number; recebidas: number; enviadas: number; ultima_direcao: Direcao; preview: string; instancia: string; primeira_mensagem_id: string; truncada: boolean }
  export interface NotaItem { tipo: 'nota'; id: string; quando: string; conteudo: string; autor: Pessoa | null; mencoes: Pessoa[] }
  export interface AtividadeItem { tipo: 'atividade'; id: string; quando: string; subtipo: string; descricao: string; dados_antes: unknown; dados_depois: unknown; autor: Pessoa | null }
  export interface TarefaItem { tipo: 'tarefa'; id: string; quando: string; evento: 'criada' | 'concluida'; titulo: string; tipo_tarefa: string; status: string; scheduled_at: string; completed_at: string | null; responsavel: Pessoa | null }
  export interface LembreteItem { tipo: 'lembrete'; id: string; quando: string; motivo: string; avisar_em: string; status: string; origem: string }
  export type TimelineItem = SessaoItem | NotaItem | AtividadeItem | TarefaItem | LembreteItem;
  export interface TimelinePage { items: TimelineItem[]; nextCursor?: string }
  export type Categoria = 'tudo' | 'conversas' | 'notas' | 'tarefas' | 'eventos';
  export const CATEGORIAS: { key: Categoria; label: string }[]
  export function categoriaDoItem(item: TimelineItem): Exclude<Categoria, 'tudo'>
  export function filtrarPorCategoria(items: TimelineItem[], cat: Categoria): TimelineItem[]
  export function rotuloSessao(s: SessaoItem): string   // "14 mensagens · 14:02–14:40" ou "1 mensagem · 14:02"
  export function rotuloTarefa(t: TarefaItem): string   // "Tarefa criada: Ligar" / "Tarefa concluída: Ligar"
  export function rotuloLembrete(l: LembreteItem): string
  export function agruparPorDia(items: TimelineItem[]): { dia: string; items: TimelineItem[] }[]  // dia = 'YYYY-MM-DD' local
  export type TipoMidia = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  export function rotuloMidia(type: string, filename: string | null): string
  ```

- [ ] **Step 1: Specs**

`apps/web/src/lib/activity-label.spec.ts`:

```ts
import { rotuloAtividade } from './activity-label';

describe('rotuloAtividade', () => {
  it('conhece os tipos gravados pelo backend', () => {
    expect(rotuloAtividade('stage_change')).toBe('Etapa alterada');
    expect(rotuloAtividade('lead_created')).toBe('Lead criado');
    expect(rotuloAtividade('lead_updated')).toBe('Lead atualizado');
    expect(rotuloAtividade('lead_merged')).toBe('Lead mesclado');
    expect(rotuloAtividade('distribution')).toBe('Lead distribuído');
    expect(rotuloAtividade('ia_temperatura')).toBe('Temperatura pela IA');
    expect(rotuloAtividade('form_resubmit')).toBe('Formulário reenviado');
    expect(rotuloAtividade('webhook')).toBe('Webhook');
    expect(rotuloAtividade('task_created')).toBe('Tarefa criada');
  });
  it('tipo desconhecido volta cru', () => {
    expect(rotuloAtividade('xpto')).toBe('xpto');
  });
});
```

`apps/web/src/lib/lead-timeline-view.spec.ts`:

```ts
import {
  agruparPorDia,
  categoriaDoItem,
  filtrarPorCategoria,
  rotuloMidia,
  rotuloSessao,
  rotuloTarefa,
  type SessaoItem,
  type TarefaItem,
  type TimelineItem,
} from './lead-timeline-view';

const sessao = (over: Partial<SessaoItem> = {}): SessaoItem => ({
  tipo: 'sessao', id: 's1', quando: '2026-09-01T17:40:00.000Z', inicio: '2026-09-01T17:02:00.000Z',
  fim: '2026-09-01T17:40:00.000Z', total: 14, recebidas: 8, enviadas: 6, ultima_direcao: 'OUTGOING',
  preview: 'fechado', instancia: 'inst-A', primeira_mensagem_id: 'm1', truncada: false, ...over,
});
const nota: TimelineItem = { tipo: 'nota', id: 'n1', quando: '2026-09-01T12:00:00.000Z', conteudo: 'x', autor: null, mencoes: [] };
const tarefa: TarefaItem = {
  tipo: 'tarefa', id: 't1', quando: '2026-09-02T09:00:00.000Z', evento: 'concluida', titulo: 'Ligar',
  tipo_tarefa: 'LIGACAO', status: 'CONCLUIDA', scheduled_at: '2026-09-01T09:00:00.000Z', completed_at: '2026-09-02T09:00:00.000Z', responsavel: null,
};
const atividade: TimelineItem = { tipo: 'atividade', id: 'a1', quando: '2026-09-01T11:00:00.000Z', subtipo: 'stage_change', descricao: '', dados_antes: null, dados_depois: null, autor: null };
const lembrete: TimelineItem = { tipo: 'lembrete', id: 'l1', quando: '2026-09-01T10:00:00.000Z', motivo: 'retorno', avisar_em: '2026-09-03T09:00:00.000Z', status: 'pendente', origem: 'ia' };

describe('categoriaDoItem / filtrarPorCategoria', () => {
  it('mapeia os 5 tipos em 4 categorias', () => {
    expect(categoriaDoItem(sessao())).toBe('conversas');
    expect(categoriaDoItem(nota)).toBe('notas');
    expect(categoriaDoItem(tarefa)).toBe('tarefas');
    expect(categoriaDoItem(lembrete)).toBe('tarefas');
    expect(categoriaDoItem(atividade)).toBe('eventos');
  });
  it('tudo devolve a lista intacta; categoria filtra', () => {
    const todos = [sessao(), nota, tarefa, atividade, lembrete];
    expect(filtrarPorCategoria(todos, 'tudo')).toBe(todos);
    expect(filtrarPorCategoria(todos, 'tarefas').map((i) => i.id)).toEqual(['t1', 'l1']);
  });
});

describe('rotulos', () => {
  it('sessao com varias mensagens mostra intervalo', () => {
    // Horas dependem do fuso da máquina: só o formato é fixo.
    expect(rotuloSessao(sessao())).toMatch(/^14 mensagens · \d{2}:\d{2}–\d{2}:\d{2}$/);
  });
  it('sessao de 1 mostra so a hora', () => {
    expect(rotuloSessao(sessao({ total: 1, inicio: sessao().fim }))).toMatch(/^1 mensagem · \d{2}:\d{2}$/);
  });
  it('sessao truncada avisa', () => {
    expect(rotuloSessao(sessao({ truncada: true }))).toMatch(/\(cortada em 500\)$/);
  });
  it('tarefa por evento', () => {
    expect(rotuloTarefa(tarefa)).toBe('Tarefa concluída: Ligar');
    expect(rotuloTarefa({ ...tarefa, evento: 'criada' })).toBe('Tarefa criada: Ligar');
  });
  it('midia por tipo', () => {
    expect(rotuloMidia('IMAGE', null)).toBe('Imagem');
    expect(rotuloMidia('DOCUMENT', 'orcamento.pdf')).toBe('orcamento.pdf');
    expect(rotuloMidia('DOCUMENT', null)).toBe('Documento');
    expect(rotuloMidia('AUDIO', null)).toBe('Áudio');
  });
});

describe('agruparPorDia', () => {
  it('mantem a ordem e agrupa por dia local', () => {
    const grupos = agruparPorDia([tarefa, nota, atividade]);
    expect(grupos).toHaveLength(2);
    expect(grupos[0].items.map((i) => i.id)).toEqual(['t1']);
    expect(grupos[1].items.map((i) => i.id)).toEqual(['n1', 'a1']);
    expect(grupos[1].dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/web && npx jest --maxWorkers=2 src/lib/activity-label.spec.ts src/lib/lead-timeline-view.spec.ts
```

- [ ] **Step 3: Implementar**

`apps/web/src/lib/activity-label.ts`:

```ts
/** Rótulo de `LeadActivity.tipo` (tipos gravados pelo backend). */
const ROTULOS: Record<string, string> = {
  stage_change: 'Etapa alterada',
  lead_created: 'Lead criado',
  lead_updated: 'Lead atualizado',
  lead_merged: 'Lead mesclado',
  distribution: 'Lead distribuído',
  ia_temperatura: 'Temperatura pela IA',
  form_resubmit: 'Formulário reenviado',
  webhook: 'Webhook',
  task_created: 'Tarefa criada',
};

export function rotuloAtividade(tipo: string): string {
  return ROTULOS[tipo] ?? tipo;
}
```

`apps/web/src/lib/lead-timeline-view.ts`:

```ts
/**
 * Tipos e helpers de tela da timeline do lead. Os tipos espelham
 * `apps/api/src/modules/leads/lead-timeline.ts`; mudou lá, muda aqui.
 */
export type Direcao = 'INCOMING' | 'OUTGOING';
export interface Pessoa { id: string; nome: string }

export interface SessaoItem {
  tipo: 'sessao'; id: string; quando: string; inicio: string; fim: string; total: number;
  recebidas: number; enviadas: number; ultima_direcao: Direcao; preview: string; instancia: string;
  primeira_mensagem_id: string; truncada: boolean;
}
export interface NotaItem {
  tipo: 'nota'; id: string; quando: string; conteudo: string; autor: Pessoa | null; mencoes: Pessoa[];
}
export interface AtividadeItem {
  tipo: 'atividade'; id: string; quando: string; subtipo: string; descricao: string;
  dados_antes: unknown; dados_depois: unknown; autor: Pessoa | null;
}
export interface TarefaItem {
  tipo: 'tarefa'; id: string; quando: string; evento: 'criada' | 'concluida'; titulo: string;
  tipo_tarefa: string; status: string; scheduled_at: string; completed_at: string | null; responsavel: Pessoa | null;
}
export interface LembreteItem {
  tipo: 'lembrete'; id: string; quando: string; motivo: string; avisar_em: string; status: string; origem: string;
}
export type TimelineItem = SessaoItem | NotaItem | AtividadeItem | TarefaItem | LembreteItem;
export interface TimelinePage { items: TimelineItem[]; nextCursor?: string }

export type Categoria = 'tudo' | 'conversas' | 'notas' | 'tarefas' | 'eventos';
export const CATEGORIAS: { key: Categoria; label: string }[] = [
  { key: 'tudo', label: 'Tudo' },
  { key: 'conversas', label: 'Conversas' },
  { key: 'notas', label: 'Notas' },
  { key: 'tarefas', label: 'Tarefas' },
  { key: 'eventos', label: 'Eventos' },
];

export function categoriaDoItem(item: TimelineItem): Exclude<Categoria, 'tudo'> {
  switch (item.tipo) {
    case 'sessao': return 'conversas';
    case 'nota': return 'notas';
    case 'tarefa':
    case 'lembrete': return 'tarefas';
    case 'atividade': return 'eventos';
  }
}

export function filtrarPorCategoria(items: TimelineItem[], cat: Categoria): TimelineItem[] {
  if (cat === 'tudo') return items;
  return items.filter((i) => categoriaDoItem(i) === cat);
}

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function rotuloSessao(s: SessaoItem): string {
  const qtd = s.total === 1 ? '1 mensagem' : `${s.total} mensagens`;
  const faixa = s.total === 1 ? hora(s.fim) : `${hora(s.inicio)}–${hora(s.fim)}`;
  return `${qtd} · ${faixa}${s.truncada ? ' (cortada em 500)' : ''}`;
}

export function rotuloTarefa(t: TarefaItem): string {
  return `${t.evento === 'concluida' ? 'Tarefa concluída' : 'Tarefa criada'}: ${t.titulo}`;
}

export function rotuloLembrete(l: LembreteItem): string {
  const origem = l.origem === 'ia' ? 'Lembrete da IA' : 'Lembrete';
  return `${origem}: ${l.motivo}`;
}

/** 'YYYY-MM-DD' no fuso local — chave de agrupamento e do cabeçalho de dia. */
function diaLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function agruparPorDia(items: TimelineItem[]): { dia: string; items: TimelineItem[] }[] {
  const grupos: { dia: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const dia = diaLocal(item.quando);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.dia === dia) ultimo.items.push(item);
    else grupos.push({ dia, items: [item] });
  }
  return grupos;
}

export type TipoMidia = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
const ROTULO_MIDIA: Record<string, string> = {
  IMAGE: 'Imagem', VIDEO: 'Vídeo', AUDIO: 'Áudio', DOCUMENT: 'Documento',
};
export function rotuloMidia(type: string, filename: string | null): string {
  if (type.toUpperCase() === 'DOCUMENT' && filename) return filename;
  return ROTULO_MIDIA[type.toUpperCase()] ?? type;
}
```

- [ ] **Step 4: Rodar os specs**

```bash
cd apps/web && npx jest --maxWorkers=2 src/lib/activity-label.spec.ts src/lib/lead-timeline-view.spec.ts
```

Expected: PASS.

- [ ] **Step 5: `activity-timeline.tsx` usa o rótulo compartilhado**

Apagar `TIPO_LABEL` e `getTipoLabel` (linhas 27-38) e importar `rotuloAtividade` de `@/lib/activity-label`; no JSX, `{getTipoLabel(item.tipo)}` vira `{rotuloAtividade(item.tipo)}`.

- [ ] **Step 6: tsc + commit**

```bash
cd apps/web && npx tsc --noEmit && cd ../.. && git add apps/web/src/lib/activity-label.ts apps/web/src/lib/activity-label.spec.ts apps/web/src/lib/lead-timeline-view.ts apps/web/src/lib/lead-timeline-view.spec.ts apps/web/src/components/kanban/activity-timeline.tsx && git commit -m "feat(web): helpers de tela da timeline do lead e rotulo de atividade compartilhado"
```

---

### Task 7: `InlineField`

**Files:**
- Create: `apps/web/src/lib/inline-field-state.ts` + `inline-field-state.spec.ts`
- Create: `apps/web/src/components/leads/inline-field.tsx`

**Interfaces:**
- Produces (`inline-field-state.ts`):
  ```ts
  export type Variante = 'text' | 'phone' | 'email' | 'currency' | 'select';
  /** normaliza o rascunho antes de comparar/salvar; null = campo limpo */
  export function normalizar(variante: Variante, rascunho: string): string | null
  /** 'salvar' | 'ignorar' (igual ao atual ou inválido) */
  export function decidirCommit(variante: Variante, atual: string | null, rascunho: string): { acao: 'salvar'; valor: string | null } | { acao: 'ignorar'; motivo: 'igual' | 'invalido' }
  export function formatarExibicao(variante: Variante, valor: string | null, opcoes?: { value: string; label: string }[]): string
  ```
- Produces (`inline-field.tsx`):
  ```tsx
  export interface InlineFieldProps {
    label: string;
    variante: Variante;
    value: string | null;
    onSave: (valor: string | null) => Promise<void>;   // rejeita com Error(message) para mostrar erro inline
    opcoes?: { value: string; label: string }[];        // só select
    placeholder?: string;                                // padrão "Adicionar…"
    disabled?: boolean;
    className?: string;
  }
  export function InlineField(props: InlineFieldProps): JSX.Element
  ```

- [ ] **Step 1: Spec**

`apps/web/src/lib/inline-field-state.spec.ts`:

```ts
import { decidirCommit, formatarExibicao, normalizar } from './inline-field-state';

describe('normalizar', () => {
  it('text: trim; vazio vira null', () => {
    expect(normalizar('text', '  Ana ')).toBe('Ana');
    expect(normalizar('text', '   ')).toBeNull();
  });
  it('phone: so digitos', () => {
    expect(normalizar('phone', '(31) 9 9999-0000')).toBe('3199990000');
  });
  it('email: minusculas e trim', () => {
    expect(normalizar('email', ' Ana@X.com ')).toBe('ana@x.com');
  });
  it('currency: aceita 1.234,56 e 1234.56, devolve string decimal com ponto', () => {
    expect(normalizar('currency', '1.234,56')).toBe('1234.56');
    expect(normalizar('currency', '1234.56')).toBe('1234.56');
    expect(normalizar('currency', 'R$ 50')).toBe('50');
    expect(normalizar('currency', 'abc')).toBeNull();
  });
});

describe('decidirCommit', () => {
  it('igual ao atual ignora', () => {
    expect(decidirCommit('text', 'Ana', ' Ana ')).toEqual({ acao: 'ignorar', motivo: 'igual' });
  });
  it('email invalido ignora', () => {
    expect(decidirCommit('email', null, 'nao-e-email')).toEqual({ acao: 'ignorar', motivo: 'invalido' });
  });
  it('currency com texto ignora como invalido, vazio limpa', () => {
    expect(decidirCommit('currency', '10.00', 'abc')).toEqual({ acao: 'ignorar', motivo: 'invalido' });
    expect(decidirCommit('currency', '10.00', '')).toEqual({ acao: 'salvar', valor: null });
  });
  it('diferente salva normalizado', () => {
    expect(decidirCommit('phone', '31999990000', '(31) 98888-0000')).toEqual({ acao: 'salvar', valor: '31988880000' });
  });
});

describe('formatarExibicao', () => {
  it('currency em BRL', () => {
    expect(formatarExibicao('currency', '1234.5')).toMatch(/R\$\s?1\.234,50/);
  });
  it('select mostra o label da opcao', () => {
    expect(formatarExibicao('select', 'QUENTE', [{ value: 'QUENTE', label: 'Quente' }])).toBe('Quente');
  });
  it('null vira vazio', () => {
    expect(formatarExibicao('text', null)).toBe('');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd apps/web && npx jest --maxWorkers=2 src/lib/inline-field-state.spec.ts
```

- [ ] **Step 3: Implementar a lib**

`apps/web/src/lib/inline-field-state.ts`:

```ts
export type Variante = 'text' | 'phone' | 'email' | 'currency' | 'select';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizar(variante: Variante, rascunho: string): string | null {
  const t = rascunho.trim();
  if (t === '') return null;
  switch (variante) {
    case 'phone': {
      const d = t.replace(/\D/g, '');
      return d === '' ? null : d;
    }
    case 'email':
      return t.toLowerCase();
    case 'currency': {
      const limpo = t.replace(/[^\d.,-]/g, '');
      if (limpo === '') return null;
      // "1.234,56" → "1234.56"; "1234.56" fica; "50" fica.
      const semMilhar = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
      const n = Number(semMilhar);
      return Number.isFinite(n) ? String(n) : null;
    }
    default:
      return t;
  }
}

export function decidirCommit(
  variante: Variante,
  atual: string | null,
  rascunho: string,
): { acao: 'salvar'; valor: string | null } | { acao: 'ignorar'; motivo: 'igual' | 'invalido' } {
  const valor = normalizar(variante, rascunho);
  const rascunhoVazio = rascunho.trim() === '';
  if (valor === null && !rascunhoVazio && (variante === 'currency' || variante === 'phone')) {
    return { acao: 'ignorar', motivo: 'invalido' };
  }
  if (variante === 'email' && valor !== null && !EMAIL.test(valor)) {
    return { acao: 'ignorar', motivo: 'invalido' };
  }
  const atualNorm = atual === null || atual === undefined ? null : normalizar(variante, atual);
  if (valor === atualNorm) return { acao: 'ignorar', motivo: 'igual' };
  return { acao: 'salvar', valor };
}

export function formatarExibicao(
  variante: Variante,
  valor: string | null,
  opcoes: { value: string; label: string }[] = [],
): string {
  if (valor === null || valor === undefined || valor === '') return '';
  if (variante === 'currency') {
    const n = Number(valor);
    return Number.isFinite(n)
      ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : valor;
  }
  if (variante === 'select') return opcoes.find((o) => o.value === valor)?.label ?? valor;
  return valor;
}
```

- [ ] **Step 4: Rodar o spec**

```bash
cd apps/web && npx jest --maxWorkers=2 src/lib/inline-field-state.spec.ts
```

Expected: PASS (11 testes).

- [ ] **Step 5: Componente**

`apps/web/src/components/leads/inline-field.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { decidirCommit, formatarExibicao, type Variante } from '@/lib/inline-field-state';

export interface InlineFieldProps {
  label: string;
  variante: Variante;
  value: string | null;
  /** Rejeita com Error(message) para mostrar o erro abaixo do campo. */
  onSave: (valor: string | null) => Promise<void>;
  opcoes?: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

type Estado = 'leitura' | 'edicao' | 'salvando';

/**
 * Campo editável no lugar: clica, edita, Enter/blur salva, Esc cancela. Valor
 * igual não chama onSave. Erro da API aparece abaixo e o valor volta.
 */
export function InlineField({
  label, variante, value, onSave, opcoes = [], placeholder = 'Adicionar…', disabled = false, className,
}: InlineFieldProps) {
  const [estado, setEstado] = useState<Estado>('leitura');
  const [rascunho, setRascunho] = useState(value ?? '');
  const [erro, setErro] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (estado === 'leitura') setRascunho(value ?? '');
  }, [value, estado]);

  useEffect(() => {
    if (estado === 'edicao' && variante !== 'select') inputRef.current?.focus();
  }, [estado, variante]);

  const cancelar = () => {
    setRascunho(value ?? '');
    setErro(null);
    setEstado('leitura');
  };

  const salvar = async (bruto: string) => {
    const decisao = decidirCommit(variante, value, bruto);
    if (decisao.acao === 'ignorar') {
      if (decisao.motivo === 'invalido') {
        setErro(variante === 'email' ? 'E-mail inválido' : 'Valor inválido');
        return;
      }
      cancelar();
      return;
    }
    setEstado('salvando');
    setErro(null);
    try {
      await onSave(decisao.valor);
      setEstado('leitura');
    } catch (e) {
      setErro(e instanceof Error && e.message ? e.message : 'Não foi possível salvar');
      setRascunho(value ?? '');
      setEstado('leitura');
    }
  };

  const exibido = formatarExibicao(variante, value, opcoes);

  return (
    <div className={cn('space-y-0.5', className)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {estado !== 'edicao' ? (
        <button
          type="button"
          disabled={disabled || estado === 'salvando'}
          onClick={() => !disabled && setEstado('edicao')}
          className={cn(
            'group flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm',
            disabled ? 'cursor-default' : 'hover:bg-accent/50',
          )}
          aria-label={`Editar ${label}`}
        >
          <span className={cn('truncate', exibido === '' && 'text-muted-foreground')}>
            {exibido === '' ? placeholder : exibido}
          </span>
          {estado === 'salvando' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : !disabled ? (
            <Pencil className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
          ) : null}
        </button>
      ) : variante === 'select' ? (
        <Select
          defaultOpen
          value={rascunho}
          onValueChange={(v) => void salvar(v)}
          onOpenChange={(aberto) => { if (!aberto && estado === 'edicao') cancelar(); }}
        >
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder={placeholder} /></SelectTrigger>
          <SelectContent>
            {opcoes.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          ref={inputRef}
          className="h-8 text-sm"
          value={rascunho}
          inputMode={variante === 'currency' || variante === 'phone' ? 'decimal' : undefined}
          type={variante === 'email' ? 'email' : 'text'}
          onChange={(e) => setRascunho(e.target.value)}
          onBlur={() => void salvar(rascunho)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void salvar(rascunho); }
            if (e.key === 'Escape') { e.preventDefault(); cancelar(); }
          }}
        />
      )}
      {erro && <p className="px-2 text-xs text-destructive">{erro}</p>}
    </div>
  );
}
```

Conferir que `@/lib/cn` exporta `cn` (existe `apps/web/src/lib/cn.ts`); se o repo usa `@/lib/utils`, trocar o import.

- [ ] **Step 6: tsc + eslint + commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/components/leads/inline-field.tsx src/lib/inline-field-state.ts && cd ../.. && git add apps/web/src/lib/inline-field-state.ts apps/web/src/lib/inline-field-state.spec.ts apps/web/src/components/leads/inline-field.tsx && git commit -m "feat(web): InlineField — campo editavel no lugar com regras de commit testadas"
```

---

### Task 8: Página `/leads/[id]` — cabeçalho, campos inline, Ficha 360

**Files:**
- Create: `apps/web/src/components/leads/lead-detail-types.ts`
- Create: `apps/web/src/components/leads/lead-header.tsx`
- Create: `apps/web/src/components/leads/lead-fields.tsx`
- Create: `apps/web/src/app/(dashboard)/leads/[id]/page.tsx`

**Interfaces:**
- Consumes: `InlineField` (Task 7); `Ficha360` (`@/components/leads/ficha-360`, props `leadId`, `lead: Ficha360Lead`, `enabled`, `mostrarCabecalho`, `colapsavel`); `FieldGroupList` (`schema`, `escopo: 'LEAD'`, `values`, `onChange(key, v)`); `useFieldSchema(enabled)` → `{ schema, modo, isError }`; `groupFields`, `flattenFields`, `initialValues`, `buildPayload` de `@/lib/field-render`; `LeadContactsBlock` (mesmas props do drawer — copiar a chamada de `lead-detail-drawer.tsx` linhas ~531-545); `TagPicker` (`value`, `onChange`); `TEMP_LABELS`, `formatPhone`, `Temperatura` de `@/components/kanban/lead-card`; `useAuthStore`, `useIsPoolEnabled`, `useIsKanbanIndividual` de `@/stores/auth.store`; `GET /api/leads/:id` (`findOne`: inclui `responsavel`, `estagio`, `pipeline`, `lead_tags`, `lead_contacts`), `GET /api/users/list`, `GET /api/pipelines?view_as_user_id=`.
- Produces:
  ```ts
  // lead-detail-types.ts
  export type LeadDetail = { id; nome; telefone; email?; temperatura: Temperatura; valor_estimado?: string|null; empresa?: string|null; cargo?: string|null; foto_url?; responsavel?: {id;nome;avatar_url?}|null; responsavel_id: string|null; tags?: string[]|null; lead_tags?: {tag:{id;nome;cor}}[]; pipeline_id; estagio_id; estagio?: {id;nome;cor?}|null; instancia_whatsapp?: string|null; is_private?: boolean; ultima_interacao?; dados_custom?; lead_contacts?; returned_at?; arquivado?: boolean }
  export function tagsDoLead(lead: LeadDetail): string[]        // relação primeiro, Json de fallback (copiar do drawer)
  export function tagsParaEditar(lead: LeadDetail): string[]    // união (copiar do drawer)
  export function lerValorEstimado(v: string|null|undefined): number|null
  export const GESTORES = ['GERENTE', 'SUPER_ADMIN'];
  export function podeEditar(role: string | undefined): boolean // role !== 'VISUALIZADOR'
  // lead-header.tsx
  export function LeadHeader(props: { lead: LeadDetail; editavel: boolean; onPatch: (body: Record<string, unknown>) => Promise<void>; onStage: (estagioId: string) => Promise<void>; onClaim: () => Promise<void>; onReassign: (userId: string) => Promise<void>; onReturnToPool: () => Promise<void> }): JSX.Element
  // lead-fields.tsx
  export function LeadFields(props: { lead: LeadDetail; editavel: boolean; onPatch: (body: Record<string, unknown>) => Promise<void> }): JSX.Element
  ```
  A página exporta default `LeadDetailPage`.

- [ ] **Step 1: Tipos e helpers compartilhados**

`apps/web/src/components/leads/lead-detail-types.ts`: mover para cá, sem alterar, as funções `lerValorEstimado`, `tagsDoLead`, `tagsDoJson`, `tagsParaEditar` e o tipo `LeadDetail` de `lead-detail-drawer.tsx` (linhas ~66-140), acrescentando ao tipo os campos `empresa`, `cargo`, `instancia_whatsapp`, `is_private`, `arquivado` (todos opcionais) e mudando `responsavel_id` para `string | null`. Exportar tudo. Acrescentar:

```ts
export const GESTORES = ['GERENTE', 'SUPER_ADMIN'];
export function podeEditar(role: string | undefined): boolean {
  return !!role && role !== 'VISUALIZADOR';
}
export const TEMP_OPCOES: { value: Temperatura; label: string }[] = (
  ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'] as Temperatura[]
).map((t) => ({ value: t, label: TEMP_LABELS[t] }));
```

`lead-detail-drawer.tsx` passa a importar essas funções e o tipo de `./../leads/lead-detail-types` (apagar as cópias locais). Rodar `npx tsc --noEmit` — o drawer não pode mudar de comportamento.

- [ ] **Step 2: Cabeçalho**

`apps/web/src/components/leads/lead-header.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuthStore, useIsKanbanIndividual } from '@/stores/auth.store';
import { formatPhone } from '@/components/kanban/lead-card';
import { TagPicker } from '@/components/kanban/tag-picker';
import { InlineField } from './inline-field';
import { GESTORES, TEMP_OPCOES, tagsParaEditar, type LeadDetail } from './lead-detail-types';

interface Stage { id: string; nome: string; ordem: number }
interface Pipeline { id: string; nome: string; stages: Stage[] }
interface TenantUser { id: string; nome: string }

export interface LeadHeaderProps {
  lead: LeadDetail;
  editavel: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onStage: (estagioId: string) => Promise<void>;
  onClaim: () => Promise<void>;
  onReassign: (userId: string) => Promise<void>;
  onReturnToPool: () => Promise<void>;
}

function iniciais(nome: string): string {
  return nome.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export function LeadHeader({ lead, editavel, onPatch, onStage, onClaim, onReassign, onReturnToPool }: LeadHeaderProps) {
  const me = useAuthStore((s) => s.user);
  const gestor = !!me?.role && GESTORES.includes(me.role);
  const kanbanIndividual = useIsKanbanIndividual();
  // No kanban individual as etapas são as do DONO do lead; gestor pede o board
  // dele com view_as_user_id (mesma regra do kanban). Operador só vê o próprio.
  const pipelineParams: Record<string, string> =
    kanbanIndividual && gestor && lead.responsavel_id && lead.responsavel_id !== me?.id
      ? { view_as_user_id: lead.responsavel_id }
      : {};
  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines', pipelineParams],
    queryFn: async () => (await api.get('/api/pipelines', { params: pipelineParams })).data,
    staleTime: 5 * 60_000,
  });
  const { data: users = [] } = useQuery<TenantUser[]>({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/api/users/list')).data,
    enabled: gestor,
  });
  const pipeline = pipelines.find((p) => p.id === lead.pipeline_id) ?? pipelines[0];
  const etapas = [...(pipeline?.stages ?? [])].sort((a, b) => a.ordem - b.ordem);
  const naNuvem = !lead.responsavel && !!lead.returned_at;
  const semDono = !lead.responsavel_id;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar className="h-14 w-14 shrink-0">
          {lead.foto_url && <AvatarImage src={lead.foto_url} alt="" />}
          <AvatarFallback className="text-base font-semibold">{iniciais(lead.nome)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <InlineField label="Nome" variante="text" value={lead.nome} disabled={!editavel}
            onSave={(v) => onPatch({ nome: v ?? '' })} className="[&>p:first-child]:sr-only" />
          <p className="px-2 text-xs text-muted-foreground">{formatPhone(lead.telefone)}</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href={`/chat/${lead.id}`}><MessageCircle className="mr-1.5 h-4 w-4" />Abrir chat</Link>
        </Button>
      </div>

      {naNuvem && <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">Disponível</Badge>}
      {lead.is_private && <Badge variant="outline">Privado</Badge>}

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <InlineField label="Temperatura" variante="select" value={lead.temperatura} opcoes={TEMP_OPCOES}
          disabled={!editavel} onSave={(v) => onPatch({ temperatura: v })} />
        <InlineField label="Etapa" variante="select" value={lead.estagio_id}
          opcoes={etapas.map((e) => ({ value: e.id, label: e.nome }))}
          disabled={!editavel || etapas.length === 0} onSave={(v) => (v ? onStage(v) : Promise.resolve())} />
        <InlineField label="Responsável" variante="select" value={lead.responsavel_id}
          opcoes={users.map((u) => ({ value: u.id, label: u.nome }))}
          placeholder={semDono ? 'Sem responsável' : undefined}
          disabled={!editavel || !gestor} onSave={(v) => (v ? onReassign(v) : Promise.resolve())} />
        <div className="space-y-0.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Instância</p>
          <p className="px-2 py-1 text-sm">{lead.instancia_whatsapp ?? '—'}</p>
        </div>
      </div>

      {editavel && (naNuvem || (semDono && !gestor)) && (
        <Button size="sm" className="w-full" onClick={() => void onClaim()}>✋ Assumir lead</Button>
      )}
      {editavel && gestor && lead.responsavel_id && (
        <Button size="sm" variant="outline" className="w-full" onClick={() => void onReturnToPool()}>
          Devolver ao escritório
        </Button>
      )}

      <div className="space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Tags</p>
        {editavel ? (
          <TagPicker value={tagsParaEditar(lead)} onChange={(next) => void onPatch({ tags: next })} />
        ) : (
          <p className="px-2 text-sm">{tagsParaEditar(lead).join(', ') || '—'}</p>
        )}
      </div>
    </div>
  );
}
```

Se `AvatarImage` não existir em `@/components/ui/avatar`, usar só `AvatarFallback` (conferir o arquivo). O botão "Assumir" para operador em lead sem dono só aparece quando o pool está ligado no tenant — acrescentar `const pool = useIsPoolEnabled();` e trocar a condição por `(naNuvem || (semDono && pool))`.

- [ ] **Step 3: Campos**

`apps/web/src/components/leads/lead-fields.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { FieldGroupList } from '@/components/fields/field-group-list';
import { LeadContactsBlock } from '@/components/fields/lead-contacts-block';
import { useFieldSchema } from '@/components/fields/use-field-schema';
import { Skeleton } from '@/components/ui/skeleton';
import { buildPayload, flattenFields, groupFields, initialValues } from '@/lib/field-render';
import { InlineField } from './inline-field';
import type { LeadDetail } from './lead-detail-types';

export interface LeadFieldsProps {
  lead: LeadDetail;
  editavel: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
}

/**
 * Campos fixos (inline) + campos personalizados por grupo (salvam ao mudar,
 * sem botão) + contatos vinculados. A separação nativo/Json é a mesma do
 * drawer (`buildPayload`).
 */
export function LeadFields({ lead, editavel, onPatch }: LeadFieldsProps) {
  const { schema, modo, isError } = useFieldSchema(true);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const leadDefs = schema ? flattenFields(groupFields(schema, 'LEAD')) : [];

  useEffect(() => {
    if (!schema) return;
    setValues(initialValues(flattenFields(groupFields(schema, 'LEAD')), lead));
  }, [lead, schema]);

  const alterarCampo = (key: string, v: unknown) => {
    const next = { ...values, [key]: v };
    setValues(next);
    const { native, custom } = buildPayload(leadDefs, next);
    const body: Record<string, unknown> = { ...native };
    if (Object.keys(custom).length > 0) body.dados_custom = custom;
    void onPatch(body);
  };

  const s = (v: string | null | undefined) => (v === undefined ? null : v);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2">
        <InlineField label="Telefone" variante="phone" value={lead.telefone} disabled={!editavel}
          onSave={(v) => onPatch({ telefone: v ?? '' })} />
        <InlineField label="E-mail" variante="email" value={s(lead.email)} disabled={!editavel}
          onSave={(v) => onPatch({ email: v })} />
        <InlineField label="Empresa" variante="text" value={s(lead.empresa)} disabled={!editavel}
          onSave={(v) => onPatch({ empresa: v })} />
        <InlineField label="Cargo" variante="text" value={s(lead.cargo)} disabled={!editavel}
          onSave={(v) => onPatch({ cargo: v })} />
        <InlineField label="Valor estimado" variante="currency" value={s(lead.valor_estimado)} disabled={!editavel}
          onSave={(v) => onPatch({ valor_estimado: v })} />
      </div>

      {isError ? (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
          Não foi possível carregar os campos personalizados.
        </p>
      ) : !schema ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className={editavel ? '' : 'pointer-events-none opacity-70'}>
          <FieldGroupList schema={schema} escopo="LEAD" values={values} onChange={alterarCampo} />
        </div>
      )}

      {modo === 'completo' && schema && (
        <LeadContactsBlock leadId={lead.id} vinculos={lead.lead_contacts ?? []} schema={schema} />
      )}
    </div>
  );
}
```

`LeadContactsBlock` exige `schema` (props reais: `leadId`, `vinculos`, `schema`), por isso a chamada fica dentro do ramo em que `schema` já existe. `updateLeadSchema` aceita `email`, `empresa` e `cargo` como `nullable`, e `valor_estimado` como STRING nullable — por isso o campo de valor manda a string decimal, não `Number`.

- [ ] **Step 4: A página**

`apps/web/src/app/(dashboard)/leads/[id]/page.tsx`:

```tsx
'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Ficha360 } from '@/components/leads/ficha-360';
import { LeadHeader } from '@/components/leads/lead-header';
import { LeadFields } from '@/components/leads/lead-fields';
import { lerValorEstimado, podeEditar, tagsDoLead, type LeadDetail } from '@/components/leads/lead-detail-types';

function statusDe(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}
function mensagemDe(err: unknown): string | undefined {
  return (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
}

export default function LeadDetailPage() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.id as string;
  const queryClient = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const editavel = podeEditar(me?.role);

  const { data: lead, isLoading, error } = useQuery<LeadDetail>({
    queryKey: ['lead', leadId],
    queryFn: async () => (await api.get(`/api/leads/${leadId}`)).data,
    enabled: !!leadId,
    retry: (count, err) => ![403, 404].includes(statusDe(err) ?? 0) && count < 2,
  });

  const invalidar = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['lead-activities', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
  };

  // Todas as gravações rejeitam com Error(message) — é o que o InlineField
  // mostra abaixo do campo. Toast só nas ações de botão.
  const chamar = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      invalidar();
    } catch (err) {
      throw new Error(mensagemDe(err) ?? 'Não foi possível salvar');
    }
  };
  const onPatch = (body: Record<string, unknown>) => chamar(() => api.patch(`/api/leads/${leadId}`, body));
  const onStage = (estagio_id: string) => chamar(() => api.patch(`/api/leads/${leadId}/stage`, { estagio_id }));
  const onReassign = (novoResponsavelId: string) =>
    chamar(() => api.post(`/api/leads/${leadId}/reassign`, { novoResponsavelId }));
  const claim = useMutation({
    mutationFn: () => chamar(() => api.post(`/api/leads/${leadId}/claim`)),
    onSuccess: () => toast.success('Lead assumido!'),
    onError: (e: Error) => toast.error(e.message),
  });
  const devolver = useMutation({
    mutationFn: () => chamar(() => api.post(`/api/leads/${leadId}/return-to-pool`)),
    onSuccess: () => toast.success('Lead devolvido ao escritório.'),
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 p-4 lg:grid-cols-[380px_1fr]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (error || !lead) {
    const s = statusDe(error);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {s === 403 || s === 404
            ? 'Lead não encontrado ou fora do seu alcance.'
            : 'Não foi possível carregar o lead.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => router.push('/leads')}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />Voltar para leads
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[380px_minmax(0,1fr)] lg:overflow-hidden">
        {/* Coluna esquerda */}
        <aside className="space-y-5 lg:overflow-y-auto lg:pr-1">
          <LeadHeader
            lead={lead}
            editavel={editavel}
            onPatch={onPatch}
            onStage={onStage}
            onClaim={() => claim.mutateAsync().then(() => undefined)}
            onReassign={onReassign}
            onReturnToPool={() => devolver.mutateAsync().then(() => undefined)}
          />
          <LeadFields lead={lead} editavel={editavel} onPatch={onPatch} />
          <Ficha360
            leadId={lead.id}
            lead={{
              nome: lead.nome,
              telefone: lead.telefone,
              etapa: lead.estagio?.nome ?? '',
              temperatura: lead.temperatura,
              valor_estimado: lerValorEstimado(lead.valor_estimado),
              ultima_interacao: lead.ultima_interacao ?? null,
              responsavel: lead.responsavel?.nome ?? null,
              tags: tagsDoLead(lead),
            }}
            mostrarCabecalho={false}
            colapsavel
          />
        </aside>

        {/* Coluna direita — Task 9 e 10 preenchem as abas */}
        <section className="flex min-h-0 flex-col">
          <Tabs defaultValue="atividade" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="shrink-0 self-start">
              <TabsTrigger value="atividade">Atividade</TabsTrigger>
              <TabsTrigger value="midia">Mídia</TabsTrigger>
            </TabsList>
            <TabsContent value="atividade" className="min-h-0 flex-1 overflow-y-auto">
              <p className="p-4 text-sm text-muted-foreground">Timeline entra na Task 9.</p>
            </TabsContent>
            <TabsContent value="midia" className="min-h-0 flex-1 overflow-y-auto">
              <p className="p-4 text-sm text-muted-foreground">Galeria entra na Task 10.</p>
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}
```

`Ficha360` com `colapsavel` abre com `aberto = true` por padrão; para nascer fechada no celular (spec), acrescentar à `Ficha360Props` uma prop opcional `abertoInicial?: boolean` (default `true`) usada no `useState(abertoInicial)` e passar `abertoInicial={typeof window !== 'undefined' && window.innerWidth >= 1024}` — mudança de 3 linhas em `ficha-360.tsx`.

- [ ] **Step 5: Conferir no navegador**

```bash
cd apps/web && npx tsc --noEmit && npx eslint "src/app/(dashboard)/leads/[id]" src/components/leads
```

Depois, com a API local ou apontando para produção (conforme `.env.local`), abrir `http://localhost:3000/leads/<id de um lead>` como gerente e como operador e conferir: cabeçalho, edição inline de nome/telefone/valor (salva ao sair), etapa (select), 403 em lead privado de outro, layout empilhado abaixo de 1024px. Não há teste automatizado de componente — este passo é a verificação.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/leads apps/web/src/components/kanban/lead-detail-drawer.tsx "apps/web/src/app/(dashboard)/leads/[id]/page.tsx" && git commit -m "feat(web): pagina /leads/[id] com cabecalho, campos inline e Ficha 360"
```

---

### Task 9: Timeline, nota interna e atualização ao vivo

**Files:**
- Create: `apps/web/src/components/chat/nota-interna-composer.tsx`
- Create: `apps/web/src/components/leads/timeline-item.tsx`
- Create: `apps/web/src/components/leads/lead-timeline.tsx`
- Modify: `apps/web/src/app/(dashboard)/leads/[id]/page.tsx` (aba Atividade)

**Interfaces:**
- Consumes: `GET /api/leads/:id/timeline?cursor&limit` → `TimelinePage` (Task 3); `POST /api/messages/internal-note` `{ lead_id, content, mentioned_user_ids }`; `lib/mentions` (Task 5); `lib/lead-timeline-view` e `lib/activity-label` (Task 6); `getSocket`, `joinLead`, `leaveLead` de `@/lib/socket`; eventos `message:new` (sala do lead) e `lead:updated`, `lead:stage-changed`, `lead:new-message` (tenant, payload com `leadId`).
- Produces:
  ```tsx
  export function NotaInternaComposer(props: { leadId: string; disabled?: boolean; onCriada?: () => void; className?: string }): JSX.Element
  export function TimelineItemView(props: { item: TimelineItem; leadId: string }): JSX.Element
  export function LeadTimeline(props: { leadId: string; editavel: boolean }): JSX.Element
  ```

- [ ] **Step 1: Composer de nota com `@`**

`apps/web/src/components/chat/nota-interna-composer.tsx`:

```tsx
'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { aplicarMencao, extractMentionIds, sugerirMencoes, type MencionavelUser } from '@/lib/mentions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';

export interface NotaInternaComposerProps {
  leadId: string;
  disabled?: boolean;
  onCriada?: () => void;
  className?: string;
}

/**
 * Nota interna (só a equipe vê) com autocomplete de @menção. Grava pelo mesmo
 * endpoint do chat; a nota aparece lá e na timeline.
 */
export function NotaInternaComposer({ leadId, disabled = false, onCriada, className }: NotaInternaComposerProps) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState('');
  const [cursor, setCursor] = useState(0);
  const [indice, setIndice] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const { data: equipe = [] } = useQuery<MencionavelUser[]>({
    queryKey: ['team-mention-users'],
    queryFn: async () => (await api.get('/api/users/list')).data,
    staleTime: 5 * 60_000,
  });

  const sugestao = sugerirMencoes(texto.slice(0, cursor), equipe);
  const sugestoes = sugestao?.sugestoes.slice(0, 6) ?? [];

  const escolher = (u: MencionavelUser) => {
    const r = aplicarMencao(texto.slice(0, cursor), texto.slice(cursor), u);
    setTexto(r.texto);
    setIndice(0);
    requestAnimationFrame(() => {
      areaRef.current?.focus();
      areaRef.current?.setSelectionRange(r.cursor, r.cursor);
      setCursor(r.cursor);
    });
  };

  const enviar = useMutation({
    mutationFn: async (content: string) =>
      (await api.post('/api/messages/internal-note', {
        lead_id: leadId,
        content,
        mentioned_user_ids: extractMentionIds(content, equipe),
      })).data,
    onSuccess: () => {
      setTexto('');
      void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['messages', leadId] });
      onCriada?.();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? 'Não foi possível salvar a nota');
    },
  });

  const submeter = () => {
    const t = texto.trim();
    if (!t || enviar.isPending) return;
    enviar.mutate(t);
  };

  return (
    <div className={cn('rounded-xl border border-amber-400/30 bg-amber-400/5 p-2', className)}>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
        <NotebookPen className="h-3 w-3" /> Nota interna · só a equipe vê
      </div>
      <div className="relative">
        <Textarea
          ref={areaRef}
          rows={2}
          disabled={disabled}
          placeholder="Escreva uma nota… use @ para mencionar alguém"
          value={texto}
          onChange={(e) => { setTexto(e.target.value); setCursor(e.target.selectionStart ?? e.target.value.length); setIndice(0); }}
          onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (sugestoes.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndice((i) => (i + 1) % sugestoes.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndice((i) => (i - 1 + sugestoes.length) % sugestoes.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); escolher(sugestoes[indice]); return; }
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submeter(); }
          }}
        />
        {sugestoes.length > 0 && (
          <ul className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border bg-popover p-1 shadow-md">
            {sugestoes.map((u, i) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={cn('w-full rounded px-2 py-1 text-left text-sm', i === indice && 'bg-accent')}
                  onMouseDown={(e) => { e.preventDefault(); escolher(u); }}
                >
                  {u.nome}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">Ctrl+Enter envia</span>
        <Button size="sm" variant="secondary" disabled={disabled || !texto.trim() || enviar.isPending} onClick={submeter}>
          <Send className="mr-1.5 h-3.5 w-3.5" />{enviar.isPending ? 'Salvando…' : 'Salvar nota'}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Item da timeline**

`apps/web/src/components/leads/timeline-item.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { Activity, ArrowRight, Bell, CheckSquare, MessageCircle, NotebookPen, Pencil, Plus } from 'lucide-react';
import { rotuloAtividade } from '@/lib/activity-label';
import { rotuloLembrete, rotuloSessao, rotuloTarefa, type TimelineItem } from '@/lib/lead-timeline-view';
import { cn } from '@/lib/cn';

const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function iconeAtividade(subtipo: string) {
  switch (subtipo) {
    case 'stage_change': return <ArrowRight className="h-3.5 w-3.5" />;
    case 'task_created': return <CheckSquare className="h-3.5 w-3.5" />;
    case 'lead_updated': return <Pencil className="h-3.5 w-3.5" />;
    case 'lead_created': return <Plus className="h-3.5 w-3.5" />;
    default: return <Activity className="h-3.5 w-3.5" />;
  }
}

/** Destaca `@Nome` das pessoas mencionadas dentro do texto da nota. */
function comMencoes(texto: string, nomes: string[]) {
  if (nomes.length === 0) return texto;
  const re = new RegExp(`@(${nomes.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const partes = texto.split(re);
  return partes.map((p, i) =>
    i % 2 === 1 ? <span key={i} className="rounded bg-amber-400/20 px-0.5 font-medium">@{p}</span> : p,
  );
}

export function TimelineItemView({ item, leadId }: { item: TimelineItem; leadId: string }) {
  const bolinha = (cls: string, icone: React.ReactNode) => (
    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', cls)}>{icone}</span>
  );

  switch (item.tipo) {
    case 'sessao':
      return (
        <li className="flex gap-3">
          {bolinha('bg-emerald-500/15 text-emerald-500', <MessageCircle className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloSessao(item)}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.ultima_direcao === 'INCOMING' ? 'Cliente: ' : 'Você: '}{item.preview}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {item.recebidas} recebidas · {item.enviadas} enviadas · {item.instancia} ·{' '}
              <Link href={`/chat/${leadId}`} className="underline-offset-2 hover:underline">abrir no chat</Link>
            </p>
          </div>
        </li>
      );
    case 'nota':
      return (
        <li className="flex gap-3">
          {bolinha('bg-amber-400/15 text-amber-500', <NotebookPen className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2">
              <p className="whitespace-pre-wrap break-words text-sm italic">
                {comMencoes(item.conteudo, item.mencoes.map((m) => m.nome))}
              </p>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {hora(item.quando)}{item.autor ? ` · ${item.autor.nome}` : ''}
            </p>
          </div>
        </li>
      );
    case 'tarefa':
      return (
        <li className="flex gap-3">
          {bolinha('bg-sky-500/15 text-sky-500', <CheckSquare className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloTarefa(item)}</p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {hora(item.quando)}{item.responsavel ? ` · ${item.responsavel.nome}` : ''} · {item.status}
            </p>
          </div>
        </li>
      );
    case 'lembrete':
      return (
        <li className="flex gap-3">
          {bolinha('bg-violet-500/15 text-violet-500', <Bell className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloLembrete(item)}</p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              avisar em {new Date(item.avisar_em).toLocaleDateString('pt-BR')} · {item.status}
            </p>
          </div>
        </li>
      );
    case 'atividade':
      return (
        <li className="flex gap-3">
          {bolinha('bg-muted text-muted-foreground', iconeAtividade(item.subtipo))}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloAtividade(item.subtipo)}</p>
            {item.descricao && <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.descricao}</p>}
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {hora(item.quando)}{item.autor ? ` · ${item.autor.nome}` : ''}
            </p>
          </div>
        </li>
      );
  }
}
```

- [ ] **Step 3: A lista com filtros, paginação e WebSocket**

`apps/web/src/components/leads/lead-timeline.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getSocket, joinLead, leaveLead } from '@/lib/socket';
import {
  agruparPorDia, CATEGORIAS, filtrarPorCategoria, type Categoria, type TimelinePage,
} from '@/lib/lead-timeline-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NotaInternaComposer } from '@/components/chat/nota-interna-composer';
import { TimelineItemView } from './timeline-item';
import { cn } from '@/lib/cn';

const diaLegivel = (dia: string) =>
  new Date(`${dia}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });

export function LeadTimeline({ leadId, editavel }: { leadId: string; editavel: boolean }) {
  const queryClient = useQueryClient();
  const [categoria, setCategoria] = useState<Categoria>('tudo');

  const q = useInfiniteQuery<TimelinePage>({
    queryKey: ['lead-timeline', leadId],
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = { limit: '40' };
      if (pageParam) params.cursor = pageParam as string;
      return (await api.get(`/api/leads/${leadId}/timeline`, { params })).data;
    },
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });

  // Ao vivo: sala do lead (message:new) e eventos do tenant com leadId.
  useEffect(() => {
    joinLead(leadId);
    const socket = getSocket();
    const invalidar = () => void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
    const seForEsteLead = (payload: { leadId?: string; lead_id?: string }) => {
      if ((payload?.leadId ?? payload?.lead_id) === leadId) invalidar();
    };
    socket.on('message:new', invalidar);
    socket.on('lead:updated', seForEsteLead);
    socket.on('lead:stage-changed', seForEsteLead);
    socket.on('lead:new-message', seForEsteLead);
    return () => {
      socket.off('message:new', invalidar);
      socket.off('lead:updated', seForEsteLead);
      socket.off('lead:stage-changed', seForEsteLead);
      socket.off('lead:new-message', seForEsteLead);
      leaveLead(leadId);
    };
  }, [leadId, queryClient]);

  const itens = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const visiveis = filtrarPorCategoria(itens, categoria);
  const grupos = agruparPorDia(visiveis);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 px-4 pt-3">
        {editavel && <NotaInternaComposer leadId={leadId} />}
        <div className="flex flex-wrap gap-1">
          {CATEGORIAS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategoria(c.key)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs',
                categoria === c.key ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {q.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : q.isError ? (
          <div className="rounded-md border border-destructive/40 p-4 text-center text-sm">
            <p className="text-destructive">Não foi possível carregar a atividade.</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void q.refetch()}>Tentar de novo</Button>
          </div>
        ) : visiveis.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {categoria === 'tudo' ? 'Nenhuma atividade ainda.' : 'Nada nesta categoria.'}
          </p>
        ) : (
          grupos.map((g) => (
            <div key={g.dia} className="mb-2">
              <p className="sticky top-0 z-10 mb-2 bg-background py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {diaLegivel(g.dia)}
              </p>
              <ol>{g.items.map((item) => <TimelineItemView key={item.id} item={item} leadId={leadId} />)}</ol>
            </div>
          ))
        )}
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button size="sm" variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {q.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

Na página (`leads/[id]/page.tsx`), trocar o placeholder da aba Atividade por `<LeadTimeline leadId={lead.id} editavel={editavel} />` e importar. Para o celular, o composer deve ficar no rodapé: dentro de `LeadTimeline`, envolver o `NotaInternaComposer` em `<div className="order-last lg:order-first sticky bottom-0 z-10 bg-background pb-2 lg:static">` e colocar o container em `flex flex-col` — abaixo de `lg` ele vai para o fim e fica fixo; acima, volta ao topo.

Redirecionamento quando o lead é arquivado durante a visita: na página, dentro de um `useEffect` que escuta `lead:updated` (mesmo padrão do `useEffect` acima), se `payload.arquivado === true && payload.leadId === leadId`, `toast.info('Lead arquivado')` e `router.push('/leads')`.

- [ ] **Step 4: Conferir no navegador**

Mesmos comandos da Task 8 (`tsc`, `eslint`), depois abrir a ficha de um lead com histórico: sessões agrupadas com contagem e horário, nota criada aparece na timeline e no chat, `@` abre sugestões, filtros funcionam, "Carregar mais" quando há mais de 40 itens, chegada de mensagem no WhatsApp atualiza a timeline sem F5.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/nota-interna-composer.tsx apps/web/src/components/leads/timeline-item.tsx apps/web/src/components/leads/lead-timeline.tsx "apps/web/src/app/(dashboard)/leads/[id]/page.tsx" && git commit -m "feat(web): timeline do lead com sessoes, notas com @mencao, filtros e atualizacao ao vivo"
```

---

### Task 10: Galeria de mídia

**AJUSTE PÓS-TASK 4 (governa sobre o código abaixo):** a API devolve `media_thumbnail_url: string | null` (URL ASSINADA da miniatura, quando existe) em vez de `media_thumbnail_path`; mídia arquivada pelo cleanup de 30 dias vem com `media_url: null` e só a thumbnail. Na grade: imagem/vídeo usam `media_thumbnail_url ?? media_url` como `src` da miniatura e abrem `media_url` no clique (se `media_url` for null, o tile mostra a thumbnail com selo "arquivada" e não é clicável). Tipo `MediaItem` do front: trocar `media_thumbnail_path` por `media_thumbnail_url`.

**Files:**
- Create: `apps/web/src/components/leads/lead-media-grid.tsx`
- Modify: `apps/web/src/app/(dashboard)/leads/[id]/page.tsx` (aba Mídia)

**Interfaces:**
- Consumes: `GET /api/leads/:id/media?cursor&limit` → `{ items: MediaItem[]; nextCursor?: string }` (Task 4); `rotuloMidia` (Task 6).
- Produces: `export function LeadMediaGrid(props: { leadId: string }): JSX.Element`.

- [ ] **Step 1: Componente**

`apps/web/src/components/leads/lead-media-grid.tsx`:

```tsx
'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FileText, Mic, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { rotuloMidia } from '@/lib/lead-timeline-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface MediaItem {
  id: string; type: string; media_url: string | null; media_mimetype: string | null;
  media_filename: string | null; media_thumbnail_path: string | null; media_duration_seconds: number | null;
  direction: 'INCOMING' | 'OUTGOING'; created_at: string;
}
interface MediaPage { items: MediaItem[]; nextCursor?: string }

const data = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

export function LeadMediaGrid({ leadId }: { leadId: string }) {
  const q = useInfiniteQuery<MediaPage>({
    queryKey: ['lead-media', leadId],
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = { limit: '40' };
      if (pageParam) params.cursor = pageParam as string;
      return (await api.get(`/api/leads/${leadId}/media`, { params })).data;
    },
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const itens = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const visuais = itens.filter((i) => i.type === 'IMAGE' || i.type === 'VIDEO');
  const arquivos = itens.filter((i) => i.type === 'AUDIO' || i.type === 'DOCUMENT');

  if (q.isLoading) return <div className="grid grid-cols-3 gap-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="aspect-square" />)}</div>;
  if (q.isError) return <p className="p-4 text-sm text-destructive">Não foi possível carregar as mídias.</p>;
  if (itens.length === 0) return <p className="p-6 text-center text-xs text-muted-foreground">Nenhuma mídia nesta conversa.</p>;

  return (
    <div className="space-y-4 p-4">
      {visuais.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {visuais.map((m) => (
            <a key={m.id} href={m.media_url ?? '#'} target="_blank" rel="noreferrer"
              className="group relative aspect-square overflow-hidden rounded-md bg-muted" title={data(m.created_at)}>
              {m.type === 'IMAGE' && m.media_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.media_url} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground"><Play className="h-6 w-6" /></div>
              )}
              <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">{data(m.created_at)}</span>
            </a>
          ))}
        </div>
      )}
      {arquivos.length > 0 && (
        <ul className="divide-y rounded-md border">
          {arquivos.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              {m.type === 'AUDIO' ? <Mic className="h-4 w-4 text-muted-foreground" /> : <FileText className="h-4 w-4 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{rotuloMidia(m.type, m.media_filename)}</span>
              {m.media_duration_seconds != null && <span className="text-xs text-muted-foreground">{m.media_duration_seconds}s</span>}
              <span className="text-xs text-muted-foreground">{data(m.created_at)}</span>
              {m.media_url && <a href={m.media_url} target="_blank" rel="noreferrer" className="text-xs underline">abrir</a>}
              <Link href={`/chat/${leadId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">chat</Link>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
          </Button>
        </div>
      )}
    </div>
  );
}
```

Na página, trocar o placeholder da aba Mídia por `<LeadMediaGrid leadId={lead.id} />`.

- [ ] **Step 2: Conferir e commitar**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/components/leads/lead-media-grid.tsx && cd ../.. && git add apps/web/src/components/leads/lead-media-grid.tsx "apps/web/src/app/(dashboard)/leads/[id]/page.tsx" && git commit -m "feat(web): galeria de midia na ficha do lead"
```

Abrir a aba Mídia de um lead com fotos e um documento; conferir que a URL assinada abre.

---

### Task 11: Pontos de entrada (drawer, sheet, tabela)

**Files:**
- Modify: `apps/web/src/components/kanban/lead-detail-drawer.tsx` (cabeçalho ~linha 455; aba Mídia ~linha 666)
- Modify: `apps/web/src/components/chat/lead-details-sheet.tsx` (~linha 85)
- Modify: `apps/web/src/components/leads/lead-table.tsx` (célula `nome`, ~linha 195; linha `<tr onClick>` ~455)

- [ ] **Step 1: Drawer**

No cabeçalho, ao lado do `Badge` de temperatura, acrescentar:

```tsx
<Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
  <Link href={`/leads/${lead.id}`}>Abrir ficha completa</Link>
</Button>
```

(`import Link from 'next/link';`). Na aba Mídia, trocar o parágrafo "A galeria de mídias da conversa ainda não está disponível…" por:

```tsx
<p className="rounded-md border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
  A galeria de mídias fica na ficha completa do lead.{' '}
  {leadId && <Link href={`/leads/${leadId}`} className="underline">Abrir ficha</Link>}
</p>
```

- [ ] **Step 2: Sheet do chat**

Abaixo do bloco de nome/telefone/badge (linha ~90), acrescentar o mesmo botão `Abrir ficha completa` apontando para `/leads/${lead.id}`.

- [ ] **Step 3: Tabela**

Na célula `nome` (procurar `if (key === 'nome')`), envolver o texto em um `Link` para `/leads/${lead.id}` com `onClick={(e) => e.stopPropagation()}` (senão o clique também abre o drawer pela linha). Ctrl+clique abre em nova aba por conta do `Link`.

- [ ] **Step 4: tsc, eslint, commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/components/kanban/lead-detail-drawer.tsx src/components/chat/lead-details-sheet.tsx src/components/leads/lead-table.tsx && cd ../.. && git add apps/web/src/components && git commit -m "feat(web): links para a ficha completa no drawer, no sheet do chat e na lista"
```

---

### Task 12: Verificação final, spec e ledger

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-ficha-lead-timeline-design.md` (seção Testes)
- Create: `.superpowers/sdd/2026-09-02-ficha-lead-timeline/progress.md`

- [ ] **Step 1: Suítes e lint completos**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && npx jest --maxWorkers=2 --silent 2>&1 | tail -4
cd ../web && npx tsc --noEmit && npx eslint src && npx jest --maxWorkers=2 --silent 2>&1 | tail -4
```

Expected: tudo verde, zero erro de lint (avisos pré-existentes são tolerados; nenhum novo `any`).

- [ ] **Step 2: Build do web**

```bash
cd apps/web && npx next build 2>&1 | tail -15
```

Expected: rota `/leads/[id]` listada, sem erro.

- [ ] **Step 3: Alinhar o spec ao que foi feito**

Na seção "Testes" do spec, trocar o bloco "Web (jest + testing-library…)" por:

```
Web (jest só roda `src/lib/**/*.spec.ts`, ambiente node — não há runner de componente):
- `mentions.spec.ts`, `activity-label.spec.ts`, `lead-timeline-view.spec.ts`, `inline-field-state.spec.ts`.
- Componentes (`InlineField`, `LeadTimeline`, `TimelineItemView`, `NotaInternaComposer`, `LeadMediaGrid`, página) são verificados por `tsc`, `eslint` e conferência manual no navegador.
```

E em "Frontend: componentes", trocar a frase sobre `NotaInternaComposer` "extraído da página do chat" por: "novo componente; a resolução de `@menção` saiu da página do chat para `lib/mentions.ts` e as duas telas a importam (o chat continua usando o toggle de nota do `ChatComposer`)". Acrescentar na seção "Permissões": "Sem acesso: 403 (privado de outro, operador fora) ou 404 (outro tenant); a página trata os dois igual."

- [ ] **Step 4: Ledger e commit**

```bash
mkdir -p .superpowers/sdd/2026-09-02-ficha-lead-timeline && cat > .superpowers/sdd/2026-09-02-ficha-lead-timeline/progress.md <<'TXT'
# SDD ledger — ficha do lead unificada com timeline
Tasks 1-4 (API): buildMessageScope extraido; GET /leads/:id/timeline e /media.
Tasks 5-11 (web): lib/mentions, lib/activity-label, lib/lead-timeline-view, lib/inline-field-state; pagina /leads/[id]; links de entrada.
Backlog: ancora ?msg= no chat; filtro ?tipos= no servidor; drawer/sheet virarem resumo curto; edicao inline na tabela (item 4 Twenty); kanban agregado (item 5); workflows (item 6).
TXT
git add docs/superpowers/specs/2026-09-02-ficha-lead-timeline-design.md .superpowers/sdd/2026-09-02-ficha-lead-timeline/progress.md && git commit -m "docs: spec e ledger da ficha do lead alinhados a implementacao"
```

- [ ] **Step 5: Entrega**

Invocar `superpowers:finishing-a-development-branch` para decidir merge na master. Runbook de deploy (spec): sem migração; backend primeiro no VPS (`/opt/crm-whatsapp`, ssh.exe do Windows, ver memória `crm-vps-ssh-windows-agent`), depois o push leva o front pela Vercel. Smoke pós-deploy: abrir `/leads/<id>` em produção como gerente e como operador, criar uma nota com `@`, conferir que ela aparece no chat.
