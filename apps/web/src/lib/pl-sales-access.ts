import { PARTNERS_TENANT } from './partners';

interface SalesAccessUser {
  id?: string;
  role?: string;
  tenantId?: string;
  pl_sales_only?: boolean;
}

/** Only the explicit server opt-in changes existing users' access. */
export const isPlSalesOnly = (user?: SalesAccessUser | null): boolean => user?.pl_sales_only === true;

export const salesHome = (user?: SalesAccessUser | null): string =>
  isPlSalesOnly(user) ? '/consorcio-pl' : '/dashboard';

const SALES_ROUTES = ['/consorcio-pl', '/leads', '/kanban', '/chat', '/agenda', '/instances', '/ajuda'];

/** Reports and settings are exact: no management subroutes are allowed. */
export function canAccessSalesRoute(user: SalesAccessUser | null | undefined, pathname: string): boolean {
  if (!isPlSalesOnly(user)) return true;
  const path = pathname.replace(/\/+$/, '') || '/';
  return ['/settings', '/dashboard', '/analytics'].includes(path) || SALES_ROUTES.some(root => path === root || path.startsWith(`${root}/`));
}

export function canConfigurePlSalesOnly(actor: SalesAccessUser | null | undefined, targetRole: string, targetId?: string): boolean {
  return !!actor && !isPlSalesOnly(actor) && actor.tenantId === PARTNERS_TENANT &&
    ['GERENTE', 'SUPER_ADMIN'].includes(actor.role ?? '') && targetRole === 'OPERADOR' &&
    (!targetId || targetId !== actor.id);
}
