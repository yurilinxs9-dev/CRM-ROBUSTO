import {
  ADMIN_TABS,
  visibleAdminTabs,
  adminTabForPath,
  canSeeAdminPath,
  firstAllowedAdminHref,
} from './admin-tabs';

const MASTER = ['*'];
const RESTRITO = ['health', 'announcements', 'ai'];

describe('visibleAdminTabs', () => {
  it('master vê todas as abas', () => {
    expect(visibleAdminTabs(MASTER)).toHaveLength(ADMIN_TABS.length);
  });

  it('restrito vê só Saúde, Avisos e IA, nessa ordem', () => {
    expect(visibleAdminTabs(RESTRITO).map((t) => t.href)).toEqual([
      '/admin/health',
      '/admin/announcements',
      '/admin/ai',
    ]);
  });

  it('sem escopo não vê aba nenhuma', () => {
    expect(visibleAdminTabs([])).toEqual([]);
    expect(visibleAdminTabs(undefined)).toEqual([]);
  });
});

describe('adminTabForPath', () => {
  it('casa /admin exato com Visão geral', () => {
    expect(adminTabForPath('/admin')?.href).toBe('/admin');
  });

  it('casa subrota com a aba mais específica', () => {
    expect(adminTabForPath('/admin/tenants/abc-123')?.href).toBe('/admin/tenants');
    expect(adminTabForPath('/admin/health')?.href).toBe('/admin/health');
  });

  it('devolve undefined para caminho fora do painel', () => {
    expect(adminTabForPath('/dashboard')).toBeUndefined();
  });

  it('não casa por colisão de prefixo (ex.: /admin/healthcare com a aba health)', () => {
    expect(adminTabForPath('/admin/healthcare')).toBeUndefined();
  });
});

describe('canSeeAdminPath', () => {
  it('restrito não entra na Visão geral nem em Clientes ou Logs', () => {
    expect(canSeeAdminPath('/admin', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/tenants', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/tenants/abc-123', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/logs', RESTRITO)).toBe(false);
  });

  it('restrito entra nas três abas dele', () => {
    expect(canSeeAdminPath('/admin/health', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/announcements', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/ai', RESTRITO)).toBe(true);
  });

  it('master entra em tudo', () => {
    expect(canSeeAdminPath('/admin', MASTER)).toBe(true);
    expect(canSeeAdminPath('/admin/logs', MASTER)).toBe(true);
  });

  it('caminho desconhecido dentro do painel é negado para o restrito', () => {
    // Aba nova sem escopo declarado não pode vazar por omissão.
    expect(canSeeAdminPath('/admin/qualquer-coisa-nova', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/qualquer-coisa-nova', MASTER)).toBe(true);
  });

  it('não vaza escopo por colisão de prefixo (/admin/healthcare vs aba health)', () => {
    expect(canSeeAdminPath('/admin/healthcare', RESTRITO)).toBe(false);
  });
});

describe('firstAllowedAdminHref', () => {
  it('restrito cai em Saúde', () => {
    expect(firstAllowedAdminHref(RESTRITO)).toBe('/admin/health');
  });

  it('master cai na Visão geral', () => {
    expect(firstAllowedAdminHref(MASTER)).toBe('/admin');
  });

  it('sem escopo não há destino', () => {
    expect(firstAllowedAdminHref([])).toBeUndefined();
  });
});
