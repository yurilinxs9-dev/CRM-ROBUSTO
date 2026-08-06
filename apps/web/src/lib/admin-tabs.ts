/**
 * Abas do painel de plataforma e as regras de visibilidade por escopo.
 * Lógica pura, fora do componente, porque o runner de teste do web só cobre
 * `src/lib` — e é aqui que mora a decisão de quem vê o quê.
 */
export type PlatformScope =
  | 'overview'
  | 'tenants'
  | 'tenant_actions'
  | 'health'
  | 'logs'
  | 'announcements'
  | 'ai'
  | '*';

export interface AdminTab {
  href: string;
  label: string;
  scope: PlatformScope;
}

/**
 * Nenhuma aba usa `tenant_actions`: esse escopo cobre só as AÇÕES dentro da
 * tela de Clientes (banir, excluir, suspender, impersonar), não uma aba.
 */
export const ADMIN_TABS: AdminTab[] = [
  { href: '/admin', label: 'Visão geral', scope: 'overview' },
  { href: '/admin/tenants', label: 'Clientes', scope: 'tenants' },
  { href: '/admin/health', label: 'Saúde', scope: 'health' },
  { href: '/admin/logs', label: 'Logs', scope: 'logs' },
  { href: '/admin/announcements', label: 'Avisos', scope: 'announcements' },
  { href: '/admin/ai', label: 'IA', scope: 'ai' },
];

const hasScope = (scopes: string[] | undefined, scope: PlatformScope) =>
  !!scopes && (scopes.includes('*') || scopes.includes(scope));

export function visibleAdminTabs(scopes: string[] | undefined): AdminTab[] {
  return ADMIN_TABS.filter((t) => hasScope(scopes, t.scope));
}

/** Aba correspondente ao caminho atual — a mais específica que casar. */
export function adminTabForPath(pathname: string): AdminTab | undefined {
  return ADMIN_TABS.filter((t) =>
    t.href === '/admin' ? pathname === '/admin' : pathname === t.href || pathname.startsWith(t.href + '/'),
  ).sort((a, b) => b.href.length - a.href.length)[0];
}

/**
 * Caminho dentro de /admin sem aba conhecida é tratado como área nova: só o
 * master entra, igual ao fail-closed do guard no backend.
 */
export function canSeeAdminPath(pathname: string, scopes: string[] | undefined): boolean {
  const tab = adminTabForPath(pathname);
  if (!tab) return hasScope(scopes, '*');
  return hasScope(scopes, tab.scope);
}

export function firstAllowedAdminHref(scopes: string[] | undefined): string | undefined {
  return visibleAdminTabs(scopes)[0]?.href;
}
