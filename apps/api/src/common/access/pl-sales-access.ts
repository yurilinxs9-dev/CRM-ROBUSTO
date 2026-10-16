export const PL_SALES_TENANT_ID = 'a44772ed-1382-4400-84fc-3fa350e23e42';

/** The flag is server-owned (AuthUser.plSalesOnly), never a request/JWT claim. */
export function isPlSalesOnly(user: { tenantId: string; role: string; plSalesOnly?: boolean }): boolean {
  return user.tenantId === PL_SALES_TENANT_ID && user.role === 'OPERADOR' && user.plSalesOnly === true;
}
