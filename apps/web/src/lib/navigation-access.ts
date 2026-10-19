import { canAccessFinance } from './finance';
import { canAccessPartners } from './partners';
import { canAccessPlSales } from './pl-sales';
import { canAccessSalesRoute } from './pl-sales-access';

/** Shared by desktop/mobile navigation and the command palette. */
export function navVisivelPara(item: { href: string }, role: string | undefined, tenantId?: string, userId?: string, plSalesOnly = false): boolean {
  if (!canAccessSalesRoute({ pl_sales_only: plSalesOnly }, item.href)) return false;
  if (plSalesOnly && item.href === '/kanban') return false;
  if (item.href === '/financeiro') return canAccessFinance(tenantId, userId);
  if (item.href === '/partners') return canAccessPartners(tenantId, plSalesOnly);
  if (item.href === '/consorcio-pl') return canAccessPlSales(tenantId ?? '', role ?? '');
  if (item.href === '/chat' && role === 'VISUALIZADOR') return false;
  if (item.href === '/followup' && role !== 'SUPER_ADMIN' && role !== 'GERENTE') return false;
  return true;
}
