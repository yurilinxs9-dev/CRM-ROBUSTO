export interface SessionUser {
  id: string;
  nome: string;
  email: string;
  role: string;
  tenantId: string;
  avatar_url?: string;
  is_platform_admin?: boolean;
  /** ["*"] = master; otherwise the allowed platform areas. */
  platform_scopes?: string[];
  focus_mode?: boolean;
  pl_sales_only?: boolean;
}

export interface AuthMeProfile {
  user: Omit<SessionUser, 'tenantId'>;
  tenant: { id: string };
}

/** Use the same server profile for login, restoration and session refresh. */
export function userFromAuthMe({ user, tenant }: AuthMeProfile): SessionUser {
  return {
    ...user,
    tenantId: tenant.id,
    focus_mode: user.focus_mode === true,
    pl_sales_only: user.pl_sales_only === true,
  };
}

/** Tokens rotate without changing access; names/avatars must not reset drafts. */
export function sessionAccessKey(user: SessionUser): string {
  return JSON.stringify([user.id, user.tenantId, user.role, user.pl_sales_only === true, user.focus_mode === true]);
}
