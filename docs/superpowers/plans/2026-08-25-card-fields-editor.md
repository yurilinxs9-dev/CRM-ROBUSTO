# Editor de campos do card (kanban) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Popover "Campos do card" na ViewBar (só kanban) que edita `config.card_fields` da view ativa — fecha o gap "plumbing sem editor" das views salvas.

**Architecture:** Componente novo `card-fields-menu.tsx` (Popover + lista fixa de 5 toggles, padrão visual do `column-menu.tsx`), renderizado pela ViewBar quando `mode === 'kanban'`. `onChange` faz round-trip por `fromSavedConfig` — nunca literal. Zero mudança de API/hook. Spec: `docs/superpowers/specs/2026-08-25-card-fields-editor-design.md`.

**Tech Stack:** Next.js 14 + TypeScript + shadcn (Popover) + lucide + Tailwind. Jest do web só cobre `lib/` — este plano não tem teste unitário; verificação é `tsc` + `build` + visual em produção.

## Global Constraints

- NUNCA `any` no TypeScript.
- `npx tsc --noEmit` e `npm run build` em `apps/web` devem sair 0 antes de commitar (se rodar jest: SEMPRE `--maxWorkers=2`, RAM 16GB).
- Config de view NUNCA montada como literal — sempre `fromSavedConfig(...)` (ordem de chaves afeta `configIgual`).
- Identidade do card (nome, foto, badge não lidas, alertas) NUNCA entra no menu.
- Semântica: `card_fields: []` = mostra tudo (5 marcados); voltar a marcar os 5 emite `[]`; mínimo 1 marcado (último `disabled`).
- Trabalhar na branch `feat/card-fields-editor` (criar de `master`).
- Commits `feat(web): ...`.

---

### Task 1: Componente + integração na ViewBar

**Files:**
- Create: `apps/web/src/components/leads/card-fields-menu.tsx`
- Modify: `apps/web/src/components/leads/view-bar.tsx` (~l.225, bloco "Filtros"; props em ~l.34)

**Interfaces:**
- Consumes: `Popover/PopoverTrigger/PopoverContent` de `@/components/ui/popover`; `Button` de `@/components/ui/button`; `Eye`, `EyeOff`, `LayoutList` de `lucide-react`; `fromSavedConfig` de `@/lib/lead-view-config`; `UseLeadView` (o objeto `view` que a ViewBar já recebe).
- Produces: `CardFieldsMenu(props: { value: string[]; onChange: (fields: string[]) => void }): JSX.Element` — exportado nomeado.

- [ ] **Step 1: Criar branch**

```bash
git checkout master && git checkout -b feat/card-fields-editor
```

- [ ] **Step 2: Criar `card-fields-menu.tsx`**

```tsx
'use client';

/**
 * Popover "Campos do card": edita config.card_fields da view (kanban).
 * Semântica do valor: [] = mostrar tudo (os 5 aparecem marcados). Desmarcar
 * grava lista explícita; voltar a marcar os 5 emite [] de novo (evita view
 * "explícita" idêntica ao default). Mínimo 1 marcado: [] já significa
 * "tudo", não há como representar "nenhum" sem mexer na API.
 * A identidade do card (nome, foto, não lidas, alertas) não é configurável
 * e por isso não aparece aqui.
 */

import { Eye, EyeOff, LayoutList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** Os 5 blocos que o LeadCard gateia via mostrar() — mesma vocabulário de lead-card.tsx. */
const CAMPOS_DO_CARD: ReadonlyArray<{ key: string; rotulo: string }> = [
  { key: 'valor_estimado', rotulo: 'Valor estimado' },
  { key: 'tags', rotulo: 'Tags' },
  { key: 'telefone', rotulo: 'Telefone' },
  { key: 'temperatura', rotulo: 'Temperatura' },
  { key: 'proximo_followup', rotulo: 'Próximo follow-up' },
];

interface CardFieldsMenuProps {
  /** config.card_fields da view ([] = tudo visível). */
  value: string[];
  onChange: (fields: string[]) => void;
}

export function CardFieldsMenu({ value, onChange }: CardFieldsMenuProps): JSX.Element {
  const marcados = value.length === 0 ? CAMPOS_DO_CARD.map((c) => c.key) : value;
  const marcado = (key: string) => marcados.includes(key);
  const soUmMarcado = marcados.length === 1;

  const alternar = (key: string) => {
    const novos = marcado(key) ? marcados.filter((k) => k !== key) : [...marcados, key];
    onChange(novos.length === CAMPOS_DO_CARD.length ? [] : novos);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Campos do card">
          <LayoutList className="h-3.5 w-3.5" />
          Campos
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <p className="px-2 py-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Campos visíveis no card
        </p>
        {CAMPOS_DO_CARD.map((campo) => {
          const ativo = marcado(campo.key);
          const travado = ativo && soUmMarcado;
          return (
            <button
              key={campo.key}
              type="button"
              disabled={travado}
              onClick={() => alternar(campo.key)}
              title={travado ? 'Pelo menos um campo precisa ficar visível' : undefined}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              style={{ color: ativo ? 'var(--text-primary)' : 'var(--text-muted)' }}
            >
              {ativo ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {campo.rotulo}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: Integrar na ViewBar** — em `view-bar.tsx`, logo APÓS o `<Button>` de Filtros (bloco `{/* ============== Filtros ============== */}`, ~l.225-234), acrescentar:

```tsx
      {mode === 'kanban' && (
        <CardFieldsMenu
          value={view.config.card_fields}
          onChange={(fields) =>
            view.setConfig(fromSavedConfig({ ...view.config, card_fields: fields }))
          }
        />
      )}
```

Imports no topo: `import { CardFieldsMenu } from './card-fields-menu';` e conferir que `fromSavedConfig` já está importado de `@/lib/lead-view-config` (a ViewBar importa `CONFIG_VAZIA` de lá — juntar no mesmo import se faltar). NÃO mexer em mais nada da ViewBar.

- [ ] **Step 4: Verificar** — `cd apps/web && npx tsc --noEmit && npm run build` — Expected: exit 0 nos dois.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/leads/card-fields-menu.tsx apps/web/src/components/leads/view-bar.tsx
git commit -m "feat(web): editor de campos do card na ViewBar do kanban"
```

---

### Task 2: Merge + deploy (front-only) + verificação

**Files:** nenhum novo.

**Interfaces:** consome a Task 1 inteira.

- [ ] **Step 1:** `cd apps/web && npx jest --maxWorkers=2 && npx tsc --noEmit && npm run build` — suíte web + typecheck + build finais, tudo verde.
- [ ] **Step 2:** Merge e push (deploy é só front — Vercel sobe sozinho; zero API, zero migration, backend não precisa rebuildar):

```bash
git checkout master && git merge --no-ff feat/card-fields-editor -m "feat: editor de campos do card no kanban" && git push origin master && git branch -d feat/card-fields-editor
```

- [ ] **Step 3: Verificar em produção** (após o build da Vercel, ~2 min): abrir o kanban em `https://crm-robusto-nine.vercel.app/kanban` → botão "Campos" aparece na ViewBar (e NÃO aparece em `/leads`) → desmarcar Tags e Telefone → cards escondem os dois blocos na hora → "Salvar como nova" (ou Salvar, com view ativa) → recarregar → view mantém os campos. Tentar desmarcar até sobrar 1 → o último fica desabilitado com tooltip.
- [ ] **Step 4:** Atualizar memória do projeto (editor de card_fields entregue — remove o follow-up pendente).

---

## Self-review (feito na escrita)

- Spec coberto: componente (T1 S2), integração só-kanban (T1 S3), semântica []↔5 marcados e mínimo 1 (código do S2: `marcados`, `soUmMarcado`, `alternar`), sem mudança de API (nenhuma task toca apps/api), verificação visual (T2 S3).
- Sem placeholders: código completo nos dois steps de código; rótulos e chaves exatos.
- Tipos consistentes: `CardFieldsMenuProps.value/onChange` casam com o uso na ViewBar (`view.config.card_fields: string[]`, `view.setConfig(LeadViewConfig)` via `fromSavedConfig`).
- Nota: as 5 chaves são as mesmas de `mostrar()` em `lead-card.tsx` e todas passam na sanitização da API (conferido na entrega anterior).
