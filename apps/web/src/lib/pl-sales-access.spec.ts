import { canAccessPartners, PARTNERS_TENANT } from './partners';
import { canAccessPlSales } from './pl-sales';
import { canAccessSalesRoute, canConfigurePlSalesOnly, isPlSalesOnly, salesHome } from './pl-sales-access';
import { navVisivelPara } from './navigation-access';

const seller = { id: 'seller', tenantId: PARTNERS_TENANT, role: 'OPERADOR', pl_sales_only: true };
const manager = { id: 'manager', tenantId: PARTNERS_TENANT, role: 'GERENTE' };

describe('opt-in PL access', () => {
  it('keeps existing operators unrestricted unless explicitly enabled', () => {
    expect(isPlSalesOnly({ ...seller, pl_sales_only: undefined })).toBe(false);
    expect(isPlSalesOnly({ ...seller, pl_sales_only: false })).toBe(false);
    expect(salesHome({ ...seller, pl_sales_only: false })).toBe('/dashboard');
    expect(canAccessSalesRoute({ ...seller, pl_sales_only: false }, '/partners')).toBe(true);
    expect(salesHome(seller)).toBe('/consorcio-pl');
  });

  it.each(['/dashboard', '/dashboard/', '/analytics', '/analytics/', '/consorcio-pl', '/consorcio-pl/vendas', '/leads', '/leads/123', '/kanban', '/chat', '/chat/123', '/agenda', '/instances', '/settings', '/settings/', '/ajuda'])('allows %s', path => {
    expect(canAccessSalesRoute(seller, path)).toBe(true);
  });

  it.each(['/dashboard/admin', '/analytics/admin', '/dashboard-extra', '/analytics-extra', '/partners', '/financeiro', '/radar', '/followup', '/admin', '/admin/tenants', '/settings/pipeline', '/settings/team', '/settings/profile', '/chat-export', '/consorcio-pl-extra', '/unknown'])('blocks %s before rendering a page', path => {
    expect(canAccessSalesRoute(seller, path)).toBe(false);
  });

  it('restricts menu and command palette while keeping PL sales independent of partners', () => {
    const canAccess = canAccessPartners as (tenant: string, plSalesOnly?: boolean) => boolean;
    expect(canAccess(PARTNERS_TENANT, true)).toBe(false);
    expect(canAccess(PARTNERS_TENANT, false)).toBe(true);
    expect(canAccessPlSales(PARTNERS_TENANT, 'OPERADOR')).toBe(true);
    for (const href of ['/partners', '/financeiro', '/radar', '/followup', '/admin']) {
      expect(navVisivelPara({ href }, seller.role, seller.tenantId, seller.id, true)).toBe(false);
    }
    for (const href of ['/dashboard', '/analytics']) {
      expect(navVisivelPara({ href }, seller.role, seller.tenantId, seller.id, true)).toBe(true);
    }
    expect(navVisivelPara({ href: '/consorcio-pl' }, seller.role, seller.tenantId, seller.id, true)).toBe(true);
    expect(navVisivelPara({ href: '/partners' }, seller.role, seller.tenantId, seller.id)).toBe(true);
    expect(navVisivelPara({ href: '/chat' }, 'VISUALIZADOR')).toBe(false);
    expect(navVisivelPara({ href: '/followup' }, 'OPERADOR')).toBe(false);
  });

  it('only lets management configure another operator in the PL tenant', () => {
    expect(canConfigurePlSalesOnly(manager, 'OPERADOR')).toBe(true);
    expect(canConfigurePlSalesOnly({ ...manager, role: 'SUPER_ADMIN' }, 'OPERADOR', 'seller')).toBe(true);
    expect(canConfigurePlSalesOnly(manager, 'OPERADOR', manager.id)).toBe(false);
    expect(canConfigurePlSalesOnly(manager, 'GERENTE')).toBe(false);
    expect(canConfigurePlSalesOnly(manager, 'VISUALIZADOR')).toBe(false);
    expect(canConfigurePlSalesOnly({ ...manager, tenantId: 'other' }, 'OPERADOR')).toBe(false);
    expect(canConfigurePlSalesOnly({ ...manager, role: 'OPERADOR' }, 'OPERADOR')).toBe(false);
    expect(canConfigurePlSalesOnly({ ...manager, pl_sales_only: true }, 'OPERADOR')).toBe(false);
  });
});
