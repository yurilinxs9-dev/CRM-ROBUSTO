# Auditoria UI/UX — CRM WhatsApp (jul/2026)

Objetivo: elevar o front pra um padrão "produto de mercado" (referências: Linear, Attio, HubSpot novo, Chatwoot 3.x), sem perder a identidade (verde #00a859, dark, Geist).

## Estado atual (o que existe)

- **Stack visual**: Tailwind + Radix + CVA (padrão shadcn), Geist Sans/Mono, dark-only (`<html class="dark">` fixo), PWA.
- **Tokens**: DOIS sistemas convivendo no `globals.css` —
  1. shadcn HSL (`--background`, `--card`, `--muted`...) usado pelos componentes ui/
  2. escala custom hex (`--bg-surface-1..4`, `--text-primary/secondary/muted`, `--border-subtle/default/strong`) usada via `style={{}}` inline em Dashboard/Analytics/Settings
- **Números do problema**: 296 `style={{...}}` inline, 271 usos de `var(--...)` em tsx, 67 hex hardcoded em componentes.
- `--primary` é hex cru num slot HSL (tailwind trata como exceção); `viewport.themeColor` é `#10b981` ≠ marca `#00a859`.

## Achados (por severidade de percepção)

### A. Coerência de sistema (a raiz da "cara de protótipo")
1. **Dual token system** — metade do app usa `bg-card`/`text-muted-foreground`, metade usa `style={{ background: 'var(--bg-surface-2)' }}`. Resultado: superfícies com tons levemente diferentes entre páginas (card do Dashboard ≠ card do Settings), e nenhuma página "erra", mas o conjunto não fecha.
2. **296 estilos inline** — impossibilita hover/focus/active via CSS, quebra consistência de transição e engorda o JSX.
3. **Emojis como ícones de UI** (tabs do Settings: 👤👥🏷️⚙️📋🧬🔗🔑) — assinatura de "gerado por IA"; nenhum produto sério usa emoji como ícone de navegação.
4. **Radius/spacing sem escala disciplinada** — mistura de `rounded-md/lg/xl` sem regra por nível de componente.

### B. Identidade e refinamento visual
5. **Verde em excesso ou de menos** — o verde #00a859 aparece como fundo de botão mas quase não existe como *acento estrutural* (indicadores ativos, focus ring, links, marcas de seleção). Produtos maduros usam a cor da marca em ~5% da tela, sempre nos mesmos lugares.
6. **Sem elevação/profundidade consistente** — cards são `border + bg` chapado; falta escala sutil de sombra/elevação pro dark (ex.: `shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]` + border gradiente em hover).
7. **Tipografia sem hierarquia forte** — títulos de seção, KPIs e labels usam poucos pesos; números de KPI sem `tabular-nums`; falta um passo de escala (11/12/13/14/16/20/28).
8. **Sem estados vazios desenhados** — empty states são `<p>` de texto; falta ilustração leve/ícone + ação primária (padrão Linear/Attio).

### C. Interação e "vida"
9. **Micro-interações ausentes** — transições não padronizadas (algumas `transition-colors`, muitas nenhuma); sem spring no drawer/dialog; framer-motion está instalado e subutilizado.
10. **Focus visível fraco** — navegação por teclado sem anel de foco consistente (a11y + polimento).
11. **Sem Command Palette (Ctrl+K)** — assinatura de sistema moderno; buscar lead/ir pra página/ação rápida. cmdk é a lib padrão.
12. **Feedback de carregamento irregular** — Skeleton em algumas páginas, `animate-pulse` div em outras, spinner em outras.

### D. Páginas específicas
13. **Kanban**: cards com muita informação no mesmo peso; falta hierarquia (nome > valor > meta-infos), contador/soma por coluna no header, e drag ghost estilizado.
14. **Chat**: lista de conversas e bolhas ok, mas timestamps/status podem agrupar melhor; composer com muitos ícones no mesmo nível (hierarquizar: enviar primário, resto secundário).
15. **Dashboard/Analytics**: KPI cards de estilos diferentes entre as duas páginas (mesmo componente, tokens diferentes); gráficos com cores fora da paleta de dados.
16. **Login/Auth**: AuthBranding ok, mas é o cartão de visita — merece o primeiro passe de polimento.
17. **Mobile**: sidebar colapsa, mas densidade de kanban/analytics no mobile precisa de revisão (cards menores, scroll horizontal com snap).

### E. Fundamentos
18. **Sem light mode** — tokens shadcn light já existem no CSS mas o app força dark. Decisão de produto: ou suportar de verdade (toggle + testar tudo) ou remover o dead code.
19. **Contraste borderline**: `--text-muted` #6b7f92 sobre `--bg-surface-2` #151d27 ≈ 4.2:1 — abaixo de AA para texto pequeno.
20. **`themeColor` do PWA** desalinhado da marca.

## Plano proposto (4 ondas, cada uma deployável)

### Onda 1 — Fundação de tokens (1 dia) ← destrava tudo
- Unificar num único sistema: mapear a escala custom (`bg-surface-*`, `text-*`, `border-*`) pro `tailwind.config` como cores nomeadas (`surface-1..4`, `ink-1..3`, `line-1..3`) e **matar os 296 inline styles** por classes.
- Corrigir `--primary` pra HSL, alinhar `themeColor`, definir escala de radius (btn=md, card=xl, input=md) e spacing.
- Trocar emojis por ícones lucide nas tabs.
- Focus ring global verde (`ring-2 ring-primary/40`).
- `tabular-nums` em todo número.

### Onda 2 — Componentes-padrão (1-2 dias)
- `<EmptyState icon título descrição ação/>` único pro app inteiro.
- `<StatCard/>` unificado (Dashboard e Analytics usam o mesmo).
- Skeleton padronizado (shimmer sutil, mesmo raio do conteúdo real).
- Elevação dark: 3 níveis de sombra/borda definidos e aplicados em Card/Dialog/Popover/Drawer.
- Motion: transições padrão (150ms ease-out em hover, 200ms em overlay), drawer/dialog com spring leve via framer-motion.

### Onda 3 — Páginas de alto tráfego (2-3 dias)
- **Kanban**: hierarquia do card (nome 14/semibold, valor em verde tabular, meta-infos 11/muted), header de coluna com contagem + soma R$, drag overlay com rotação 2° e sombra.
- **Chat**: agrupamento visual de mensagens consecutivas, divisor de data mais sutil, composer com hierarquia (send primário verde, demais ghost).
- **Dashboard/Analytics**: mesma família de KPI, paleta de dados fixa (verde=positivo, âmbar=atenção, azul=neutro), tooltips consistentes.
- **Login/registro/reset**: passe de polimento no AuthBranding (gradiente sutil no verde, tipografia maior).

### Onda 4 — Assinaturas de produto moderno (2 dias)
- **Command Palette Ctrl+K** (cmdk): buscar lead por nome/telefone, pular pra página, ações (nova nota, novo lead).
- Atalhos de teclado no chat (↑↓ navegar conversas, Esc fecha).
- Toasts com ação (desfazer onde couber).
- Page transitions sutis (fade 120ms).
- Decisão light mode: suportar ou remover.

### Régua de aceite (anti "cara de IA")
- Zero emoji como ícone; zero estilo inline em página; uma única escala de superfície; verde só em: ação primária, item ativo, focus, links, sucesso; todo número tabular; todo empty state com ação; toda lista com skeleton do mesmo formato do conteúdo.

## Ordem recomendada
Onda 1 primeiro (sem ela, qualquer polimento vira retrabalho). Ondas 2-3 entregam o salto perceptível. Onda 4 é a cereja "sistema caro".
