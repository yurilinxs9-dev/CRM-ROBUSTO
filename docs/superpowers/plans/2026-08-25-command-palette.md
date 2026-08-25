# Command palette Ctrl+K — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+K/Cmd+K (e o campo do topbar) abre palette cmdk com Leads (busca server), Navegação, Views salvas e Ações — item 2 da rodada Twenty.

**Architecture:** wrapper shadcn `ui/command.tsx` sobre o `cmdk` já instalado; `command-palette.tsx` montado uma vez no layout do dashboard, aberto por atalho global ou evento custom `abrir-palette`; `header-search.tsx` vira gatilho; kanban lê `?novo=1` e abre o dialog de novo lead existente. Spec: `docs/superpowers/specs/2026-08-25-command-palette-design.md`.

**Tech Stack:** Next.js 14 App Router + TypeScript + cmdk ^1.1.1 + shadcn/Tailwind + TanStack Query + lucide. Jest do web só cobre `lib/` — verificação por `tsc` + `build` + visual.

## Global Constraints

- NUNCA `any` no TypeScript.
- `npx tsc --noEmit` e `npm run build` em `apps/web` saem 0 antes de cada commit (jest, se rodar: `--maxWorkers=2`, RAM 16GB).
- Branch `feat/command-palette` criada de `master`.
- Item "Admin" da navegação só para `role === 'SUPER_ADMIN'` (`useAuthStore` de `@/stores/auth.store`).
- Busca de leads: debounce 300ms, `enabled` só com `q.trim().length >= 2`, `limit: 8`, destino `/chat/:id`.
- localStorage sempre em try/catch (chave da view ativa: `crm.leadView`).
- Commits `feat(web):` / `fix(web):`.

---

### Task 1: Wrapper shadcn do cmdk

**Files:**
- Create: `apps/web/src/components/ui/command.tsx`

**Interfaces:**
- Consumes: `cmdk` (dependência existente), `Dialog, DialogContent` de `@/components/ui/dialog`, `cn` de `@/lib/utils`, `Search` de `lucide-react`.
- Produces (Task 2 consome): `CommandDialog({ open, onOpenChange, children })`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator`, e o `Command` raiz com prop `shouldFilter`.

- [ ] **Step 1: Criar branch**

```bash
git checkout master && git pull origin master && git checkout -b feat/command-palette
```

- [ ] **Step 2: Criar `command.tsx`** (padrão shadcn adaptado às vars CSS do projeto):

```tsx
'use client';

/**
 * Wrapper shadcn do cmdk. Único ponto do app que importa 'cmdk' —
 * a palette (layout/command-palette.tsx) consome só estes componentes.
 */

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn('flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground', className)}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shouldFilter?: boolean;
  children: React.ReactNode;
}

function CommandDialog({ open, onOpenChange, shouldFilter, children }: CommandDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-lg sm:max-w-lg">
        <Command
          shouldFilter={shouldFilter}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center border-b px-3">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-80 overflow-y-auto overflow-x-hidden py-1', className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm text-muted-foreground" {...props} />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group ref={ref} className={cn('overflow-hidden text-foreground', className)} {...props} />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator ref={ref} className={cn('my-1 h-px bg-border', className)} {...props} />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-sm text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator };
```

Se `@/components/ui/dialog` não exportar `DialogContent` com essas props, ler o arquivo e ajustar a chamada ao padrão local (é o mesmo Dialog usado pelo `lead-filter-panel`).

- [ ] **Step 3: Verificar** — `cd apps/web && npx tsc --noEmit` — exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/command.tsx
git commit -m "feat(web): wrapper shadcn do cmdk (Command/CommandDialog)"
```

---

### Task 2: Palette + montagem no layout + topbar como gatilho

**Files:**
- Create: `apps/web/src/components/layout/command-palette.tsx`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx` (montar `<CommandPalette />`)
- Modify: `apps/web/src/components/layout/header-search.tsx` (REESCREVER: vira botão-gatilho)

**Interfaces:**
- Consumes: Task 1 (todos os componentes de `@/components/ui/command`); `api` de `@/lib/api`; `useAuthStore` de `@/stores/auth.store` (`s.user?.role`); `useQuery` do TanStack; `useRouter` de `next/navigation`; ícones lucide.
- Produces: `CommandPalette(): JSX.Element` (sem props); evento global `'abrir-palette'` (CustomEvent sem payload) que abre a palette — Task 3 não depende, mas o header-search sim.

- [ ] **Step 1: Criar `command-palette.tsx`**

```tsx
'use client';

/**
 * Palette global Ctrl+K (rodada Twenty item 2). Montada UMA vez no layout
 * do dashboard. Abre por Ctrl/Cmd+K ou pelo CustomEvent 'abrir-palette'
 * (disparado pelo campo de busca do topbar) — evento em vez de store:
 * dois pontos de abertura não justificam estado compartilhado novo.
 * shouldFilter={false}: a seção Leads já vem filtrada do servidor; as
 * seções estáticas são filtradas na mão (filtro simples por substring).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar, Columns3, LayoutDashboard, List, MessageSquare, Plus,
  Send, Settings, Shield, Smartphone, User, Bookmark,
} from 'lucide-react';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

interface LeadResult {
  id: string;
  nome: string | null;
  telefone: string | null;
}

interface ViewResult {
  id: string;
  nome: string;
  tipo_padrao: string;
}

const NAVEGACAO: ReadonlyArray<{ rotulo: string; href: string; Icone: typeof List; soAdmin?: boolean }> = [
  { rotulo: 'Dashboard', href: '/dashboard', Icone: LayoutDashboard },
  { rotulo: 'Kanban', href: '/kanban', Icone: Columns3 },
  { rotulo: 'Leads', href: '/leads', Icone: List },
  { rotulo: 'Conversas', href: '/chat', Icone: MessageSquare },
  { rotulo: 'Follow-up IA', href: '/followup', Icone: Send },
  { rotulo: 'Agenda', href: '/agenda', Icone: Calendar },
  { rotulo: 'Instâncias', href: '/instances', Icone: Smartphone },
  { rotulo: 'Configurações', href: '/settings', Icone: Settings },
  { rotulo: 'Admin', href: '/admin', Icone: Shield, soAdmin: true },
];

export function CommandPalette(): JSX.Element {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const [open, setOpen] = useState(false);
  const [busca, setBusca] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const aoAbrir = () => setOpen(true);
    window.addEventListener('keydown', aoTeclar);
    window.addEventListener('abrir-palette', aoAbrir);
    return () => {
      window.removeEventListener('keydown', aoTeclar);
      window.removeEventListener('abrir-palette', aoAbrir);
    };
  }, []);

  // Limpa a busca ao fechar, pra reabrir sempre neutro.
  useEffect(() => {
    if (!open) {
      setBusca('');
      setDebounced('');
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca.trim()), 300);
    return () => clearTimeout(t);
  }, [busca]);

  const { data: leads = [], isFetching } = useQuery<LeadResult[]>({
    queryKey: ['palette-search', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: async () => {
      const { data } = await api.get('/api/leads', { params: { search: debounced, limit: 8 } });
      return (Array.isArray(data) ? data : (data?.data ?? [])) as LeadResult[];
    },
  });

  const { data: views = [] } = useQuery<ViewResult[]>({
    queryKey: ['lead-views'],
    enabled: open,
    queryFn: async () => {
      const { data } = await api.get('/api/lead-views');
      return data as ViewResult[];
    },
  });

  const ir = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const ativarView = (view: ViewResult) => {
    try {
      localStorage.setItem('crm.leadView', view.id);
    } catch {
      // storage indisponível: navega mesmo assim, sem view ativa
    }
    ir(view.tipo_padrao === 'lista' ? '/leads' : '/kanban');
  };

  const filtro = debounced.toLowerCase();
  const contem = (texto: string) => !filtro || texto.toLowerCase().includes(filtro);
  const navegacaoVisivel = useMemo(
    () => NAVEGACAO.filter((n) => (!n.soAdmin || role === 'SUPER_ADMIN') && contem(n.rotulo)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role, filtro],
  );
  const viewsVisiveis = views.filter((v) => contem(v.nome));
  const mostrarNovoLead = contem('novo lead');
  const nadaEncontrado =
    leads.length === 0 && navegacaoVisivel.length === 0 && viewsVisiveis.length === 0 && !mostrarNovoLead && !isFetching;

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput placeholder="Buscar lead, tela, view ou ação..." value={busca} onValueChange={setBusca} />
      <CommandList>
        {nadaEncontrado && <CommandEmpty>Nada encontrado.</CommandEmpty>}
        {debounced.length >= 2 && leads.length > 0 && (
          <>
            <CommandGroup heading="Leads">
              {leads.map((lead) => (
                <CommandItem key={lead.id} value={`lead-${lead.id}`} onSelect={() => ir(`/chat/${lead.id}`)}>
                  <User className="h-4 w-4 opacity-70" />
                  <span className="truncate">{lead.nome || lead.telefone || 'Sem nome'}</span>
                  {lead.nome && lead.telefone && (
                    <span className="ml-auto text-xs text-muted-foreground">{lead.telefone}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        {navegacaoVisivel.length > 0 && (
          <CommandGroup heading="Navegação">
            {navegacaoVisivel.map(({ rotulo, href, Icone }) => (
              <CommandItem key={href} value={`nav-${href}`} onSelect={() => ir(href)}>
                <Icone className="h-4 w-4 opacity-70" />
                {rotulo}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {viewsVisiveis.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Views salvas">
              {viewsVisiveis.map((view) => (
                <CommandItem key={view.id} value={`view-${view.id}`} onSelect={() => ativarView(view)}>
                  <Bookmark className="h-4 w-4 opacity-70" />
                  <span className="truncate">{view.nome}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {view.tipo_padrao === 'lista' ? 'Lista' : 'Kanban'}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {mostrarNovoLead && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Ações">
              <CommandItem value="acao-novo-lead" onSelect={() => ir('/kanban?novo=1')}>
                <Plus className="h-4 w-4 opacity-70" />
                Novo lead
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
```

Conferir o shape real da resposta de `GET /api/leads` (a busca antiga do `header-search.tsx` l.43-46 mostra como ela consome) e ajustar a linha `Array.isArray(data) ? ...` para o formato verdadeiro — sem inventar campo.

- [ ] **Step 2: Montar no layout** — em `apps/web/src/app/(dashboard)/layout.tsx`, importar `CommandPalette` e renderizar `<CommandPalette />` como irmão do conteúdo (dentro do provider de Query já existente). Uma linha de import + uma de render; nada mais muda.

- [ ] **Step 3: Reescrever `header-search.tsx`** — substituir TODO o conteúdo por:

```tsx
'use client';

/**
 * Campo de busca do topbar — desde a palette (Ctrl+K), é só um gatilho:
 * a busca de verdade vive em layout/command-palette.tsx. Mantém a cara
 * de input para não mudar o layout do header.
 */

import { Search } from 'lucide-react';

export function HeaderSearch(): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('abrir-palette'))}
      className="flex h-9 w-64 items-center gap-2 rounded-md border bg-transparent px-3 text-sm text-muted-foreground transition-colors hover:bg-accent"
    >
      <Search className="h-4 w-4" />
      <span className="flex-1 text-left">Buscar contato...</span>
      <kbd className="rounded border px-1.5 py-0.5 text-[10px] font-medium">Ctrl K</kbd>
    </button>
  );
}
```

Antes de reescrever, ler o arquivo atual e preservar classes de largura/estilo do wrapper se o header depender delas (o header o renderiza em `header.tsx:61`).

- [ ] **Step 4: Verificar** — `cd apps/web && npx tsc --noEmit && npm run build` — exit 0 nos dois.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/command-palette.tsx apps/web/src/components/layout/header-search.tsx "apps/web/src/app/(dashboard)/layout.tsx"
git commit -m "feat(web): command palette Ctrl+K (leads, navegacao, views, acoes)"
```

---

### Task 3: Kanban abre Novo Lead via ?novo=1

**Files:**
- Modify: `apps/web/src/app/(dashboard)/kanban/page.tsx` (`openNewLead` definido ~l.784; adicionar efeito perto dos outros efeitos do componente)

**Interfaces:**
- Consumes: `openNewLead(stageId: string | null)` já existente; `useSearchParams`/`useRouter` de `next/navigation` (conferir se a página já importa).
- Produces: rota `/kanban?novo=1` abre o dialog de novo lead uma única vez.

- [ ] **Step 1: Implementar o efeito** — dentro do componente da página:

```tsx
  // Palette (Ctrl+K) chega com ?novo=1 pedindo o dialog de novo lead.
  // Dispara uma vez, só depois dos stages carregarem, e limpa a URL para
  // refresh não reabrir.
  const searchParams = useSearchParams();
  const novoDisparado = useRef(false);
  useEffect(() => {
    if (novoDisparado.current) return;
    if (searchParams.get('novo') !== '1') return;
    if (stages.length === 0) return;
    novoDisparado.current = true;
    openNewLead(null);
    router.replace('/kanban');
  }, [searchParams, stages.length]);
```

Ajustes ao integrar: usar o `router` que a página já tem (ou importar); se `useEffect`/`useRef` já importados, não duplicar; se o lint exigir `openNewLead`/`router` nas deps, incluir (são estáveis o bastante — `openNewLead` é função local recriada por render, então preferir deps `[searchParams, stages.length]` com comentário `eslint-disable-next-line react-hooks/exhaustive-deps` se o lint reclamar, no padrão que o arquivo já usa em outros efeitos — conferir).

- [ ] **Step 2: Verificar** — `cd apps/web && npx tsc --noEmit && npm run build` — exit 0.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(dashboard)/kanban/page.tsx"
git commit -m "feat(web): kanban abre dialog de novo lead via ?novo=1 (palette)"
```

---

### Task 4: Merge + deploy (front-only) + verificação

**Files:** nenhum novo.

- [ ] **Step 1:** `cd apps/web && npx jest --maxWorkers=2 && npx tsc --noEmit && npm run build` — tudo verde.
- [ ] **Step 2:**

```bash
git checkout master && git merge --no-ff feat/command-palette -m "feat: command palette Ctrl+K" && git push origin master && git branch -d feat/command-palette
```

- [ ] **Step 3: Visual em produção** (Vercel ~2min): Ctrl+K abre; digitar nome acha lead, Enter cai em `/chat/:id`; "Kanban"/"Leads" navegam; view salva ativa e cai na tela do `tipo_padrao`; "Novo lead" abre o dialog no kanban e a URL fica limpa; clicar no campo do topbar abre a palette; conferir que não-SUPER_ADMIN não vê "Admin" (se houver conta de teste à mão — senão anotar como pendência do usuário).
- [ ] **Step 4:** Atualizar memória do projeto (item 2 da rodada Twenty entregue).

---

## Self-review (feito na escrita)

- Spec coberto: wrapper (T1), palette com 4 seções + atalho + evento (T2 S1), montagem única (T2 S2), topbar gatilho (T2 S3), ?novo=1 (T3), deploy/visual (T4).
- Sem placeholders: código completo; os dois pontos "conferir shape/arquivo real" são instruções de leitura com localização exata, não TBD.
- Tipos consistentes: `LeadResult`/`ViewResult` locais da palette; `CommandDialog({ open, onOpenChange, shouldFilter })` da T1 casa com o uso na T2; evento `'abrir-palette'` igual nos dois lados.
- Decisão registrada: `shouldFilter={false}` com filtro manual por substring nas seções estáticas — o filtro fuzzy do cmdk não pode reordenar leads que o servidor já ranqueou.
