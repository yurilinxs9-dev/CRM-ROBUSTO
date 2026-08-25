# Command palette Ctrl+K — Design

Item 2 da rodada Twenty (`docs/superpowers/research/2026-08-24-twenty-reference.md`): busca global e ações num palette acionado por teclado, no padrão do Twenty/Linear.

## Objetivo

`Ctrl+K`/`Cmd+K` (e o campo de busca do topbar) abre um dialog cmdk com quatro seções: Leads (busca server), Navegação, Views salvas e Ações. Sem backend novo.

## Componentes

1. **`apps/web/src/components/ui/command.tsx`** — wrapper shadcn padrão do `cmdk` (já dependência, `^1.1.1`): `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator`, `CommandShortcut`. Estilo com as vars CSS do projeto (mesma linguagem do `column-menu`/popover).

2. **`apps/web/src/components/layout/command-palette.tsx`** — client component, montado UMA vez em `apps/web/src/app/(dashboard)/layout.tsx`:
   - Estado `open` interno + listener global `keydown` (`(e.ctrlKey || e.metaKey) && e.key === 'k'` → `preventDefault` + toggle). Expõe abertura externa via evento custom `window.dispatchEvent(new CustomEvent('abrir-palette'))` que o componente escuta — evita context/store novo.
   - **Leads:** input do cmdk com debounce 300ms → `GET /api/leads?search=<q>&limit=8` (`queryKey ['palette-search', q]`, `enabled: q.length >= 2`). `shouldFilter={false}` no grupo (resultado já vem filtrado do servidor). Enter/click → `router.push('/chat/'+id)` + fecha. Item mostra nome + telefone.
   - **Navegação:** itens estáticos com ícone lucide: Dashboard `/dashboard`, Kanban `/kanban`, Leads `/leads`, Conversas `/chat`, Follow-up IA `/followup`, Agenda `/agenda`, Instâncias `/instances`, Configurações `/settings`; Admin `/admin` só quando `useAuthStore(s => s.user?.role) === 'SUPER_ADMIN'`. Filtragem local do cmdk.
   - **Views salvas:** `useQuery(['lead-views'])` (mesma queryKey/cache das telas). Selecionar: `localStorage.setItem('crm.leadView', id)` (try/catch) + `router.push(view.tipo_padrao === 'lista' ? '/leads' : '/kanban')` + fecha — o `useLeadView` adota o id na montagem; hook intocado.
   - **Ações:** "Novo lead" → `router.push('/kanban?novo=1')` + fecha.

3. **`apps/web/src/components/layout/header-search.tsx`** — REESCRITO: vira botão com cara de campo ("Buscar contato…" + kbd `Ctrl K`) que dispara `abrir-palette`. A busca própria (useQuery/debounce/dropdown) morre — a palette é a única busca.

4. **`apps/web/src/app/(dashboard)/kanban/page.tsx`** — lê `useSearchParams()` uma vez na montagem: se `novo=1`, chama `openNewLead(null)` (já existe, ~l.784) e limpa o param via `router.replace('/kanban')` para não reabrir em refresh. Guard: só dispara com `stages.length > 0` (mesma condição do botão); se os stages ainda não carregaram, espera-os (efeito depende de `stages.length`) e dispara uma única vez (ref).

## Decisões

- Evento custom em vez de store/context: dois pontos de abertura (tecla + topbar), zero estado compartilhado a mais.
- Busca de leads exige ≥2 caracteres (evita rajada de queries); com campo vazio a palette mostra Navegação/Views/Ações.
- Rota `/chat/:id` como destino do lead — comportamento herdado da busca do topbar que está sendo substituída.
- Sem busca em mensagens (exigiria índice/endpoint novo — rodada futura).

## Testes e verificação

- Jest do web cobre só `lib/` — sem unit test; a palette é fiação de peças testadas.
- `npx tsc --noEmit` + `npm run build`.
- Visual em produção: Ctrl+K abre; digitar acha lead e Enter cai na conversa; navegação navega; view salva ativa e cai na tela certa; "Novo lead" abre o dialog no kanban; clicar no campo do topbar abre a palette; usuário não-SUPER_ADMIN não vê "Admin".

## Fora de escopo

- Busca full-text em mensagens/conversas.
- Ações contextuais por tela (ex.: "mover lead de etapa").
- Histórico/recentes na palette.
