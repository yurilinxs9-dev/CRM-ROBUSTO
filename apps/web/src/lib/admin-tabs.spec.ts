import {
  ADMIN_TABS,
  visibleAdminTabs,
  adminTabForPath,
  canSeeAdminPath,
  firstAllowedAdminHref,
} from './admin-tabs';

const MASTER = ['*'];
// O admin restrito (lucas) recebe TODOS os escopos nomeados — mesmas abas do
// master. O que ele não tem é o '*', e é o '*' que dispensa a proteção do
// tenant do master no backend.
const RESTRITO = ['overview', 'tenants', 'tenant_actions', 'health', 'logs', 'announcements', 'ai'];
// Admin com concessão parcial, para provar que o filtro por escopo é real.
const PARCIAL = ['health', 'ai'];

describe('visibleAdminTabs', () => {
  it('master vê todas as abas', () => {
    expect(visibleAdminTabs(MASTER)).toHaveLength(ADMIN_TABS.length);
  });

  it('restrito com todos os escopos vê as mesmas seis abas', () => {
    expect(visibleAdminTabs(RESTRITO).map((t) => t.href)).toEqual(ADMIN_TABS.map((t) => t.href));
  });

  it('concessão parcial vê só as abas concedidas', () => {
    expect(visibleAdminTabs(PARCIAL).map((t) => t.href)).toEqual(['/admin/health', '/admin/ai']);
  });

  it('sem escopo não vê aba nenhuma', () => {
    expect(visibleAdminTabs([])).toEqual([]);
    expect(visibleAdminTabs(undefined)).toEqual([]);
  });

  it('tenant_actions sozinho não abre aba nenhuma — é escopo de ação, não de tela', () => {
    expect(visibleAdminTabs(['tenant_actions'])).toEqual([]);
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
  it('restrito entra em todas as telas, inclusive Clientes e Logs', () => {
    expect(canSeeAdminPath('/admin', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/tenants', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/tenants/abc-123', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/logs', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/health', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/announcements', RESTRITO)).toBe(true);
    expect(canSeeAdminPath('/admin/ai', RESTRITO)).toBe(true);
  });

  it('concessão parcial não entra no que não recebeu', () => {
    expect(canSeeAdminPath('/admin', PARCIAL)).toBe(false);
    expect(canSeeAdminPath('/admin/tenants', PARCIAL)).toBe(false);
    expect(canSeeAdminPath('/admin/logs', PARCIAL)).toBe(false);
    expect(canSeeAdminPath('/admin/health', PARCIAL)).toBe(true);
    expect(canSeeAdminPath('/admin/ai', PARCIAL)).toBe(true);
  });

  it('master entra em tudo', () => {
    expect(canSeeAdminPath('/admin', MASTER)).toBe(true);
    expect(canSeeAdminPath('/admin/logs', MASTER)).toBe(true);
  });

  it('caminho desconhecido dentro do painel só abre para o master', () => {
    // Aba nova sem escopo declarado não pode vazar por omissão — mesmo
    // fail-closed do guard no backend.
    expect(canSeeAdminPath('/admin/qualquer-coisa-nova', RESTRITO)).toBe(false);
    expect(canSeeAdminPath('/admin/qualquer-coisa-nova', PARCIAL)).toBe(false);
    expect(canSeeAdminPath('/admin/qualquer-coisa-nova', MASTER)).toBe(true);
  });

  it('não vaza escopo por colisão de prefixo (/admin/healthcare vs aba health)', () => {
    expect(canSeeAdminPath('/admin/healthcare', PARCIAL)).toBe(false);
  });
});

describe('firstAllowedAdminHref', () => {
  it('restrito cai na Visão geral, igual ao master', () => {
    expect(firstAllowedAdminHref(RESTRITO)).toBe('/admin');
  });

  it('concessão parcial cai na primeira aba que tem', () => {
    expect(firstAllowedAdminHref(PARCIAL)).toBe('/admin/health');
  });

  it('master cai na Visão geral', () => {
    expect(firstAllowedAdminHref(MASTER)).toBe('/admin');
  });

  it('sem escopo não há destino', () => {
    expect(firstAllowedAdminHref([])).toBeUndefined();
  });
});
