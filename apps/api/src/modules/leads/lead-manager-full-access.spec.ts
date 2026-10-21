import { UserRole } from '@/common/types/roles';
import { buildVisibilityWhere, hasManagerFullAccess } from './lead-visibility';
import { buildMessageScope } from './lead-message-scope';
import type { MessageScopeCtx, MessageScopeLead } from './lead-message-scope';

/**
 * Acesso total do gestor (`Tenant.manager_full_access`, caso Ferbraço): o dono
 * da conta e os gerentes que ele nomear veem e respondem TODAS as conversas,
 * privadas inclusive. Desligado, o anti-leak do chat (caso Cajuru) segue igual.
 */

const uid = 'u-dono-conta';

describe('hasManagerFullAccess', () => {
  it('só gestor, com a flag e fora do modo foco', () => {
    expect(hasManagerFullAccess('SUPER_ADMIN', true, false)).toBe(true);
    expect(hasManagerFullAccess('GERENTE', true, undefined)).toBe(true);
    expect(hasManagerFullAccess('GERENTE', true, true)).toBe(false);
    expect(hasManagerFullAccess('GERENTE', false, false)).toBe(false);
    expect(hasManagerFullAccess('GERENTE', undefined, false)).toBe(false);
    expect(hasManagerFullAccess('OPERADOR', true, false)).toBe(false);
    expect(hasManagerFullAccess('VISUALIZADOR', true, false)).toBe(false);
  });
});

describe('buildVisibilityWhere — acesso total do gestor', () => {
  it.each([UserRole.GERENTE, UserRole.SUPER_ADMIN])(
    '%s vê tudo no chat do modo Individual, privados inclusive',
    (role) => {
      expect(buildVisibilityWhere({
        userId: uid, role, poolEnabled: false, scope: 'chat', managerFullAccess: true,
      })).toEqual({});
    },
  );

  it('vale também no Compartilhado, no Kanban e no Radar', () => {
    expect(buildVisibilityWhere({
      userId: uid, role: UserRole.GERENTE, poolEnabled: true, managerFullAccess: true,
    })).toEqual({});
    expect(buildVisibilityWhere({
      userId: uid, role: UserRole.GERENTE, poolEnabled: false, managerFullAccess: true,
    })).toEqual({});
    expect(buildVisibilityWhere({
      userId: uid, role: UserRole.GERENTE, poolEnabled: false, scope: 'radar', managerFullAccess: true,
    })).toEqual({});
  });

  it('operador não ganha nada: segue só com as próprias no chat', () => {
    expect(buildVisibilityWhere({
      userId: uid, role: UserRole.OPERADOR, poolEnabled: false, scope: 'chat', managerFullAccess: true,
    })).toEqual({ responsavel_id: uid });
  });

  it('gestor em modo foco abre mão do acesso total', () => {
    expect(buildVisibilityWhere({
      userId: uid, role: UserRole.GERENTE, poolEnabled: false, scope: 'chat',
      focusMode: true, managerFullAccess: true,
    })).toEqual({ responsavel_id: uid });
  });

  it('desligado no tenant mantém o anti-leak do chat para o gerente', () => {
    expect(buildVisibilityWhere({
      userId: uid, role: UserRole.GERENTE, poolEnabled: false, scope: 'chat', managerFullAccess: false,
    })).toEqual({ responsavel_id: uid });
  });

  it('perfil restrito (ownOnly) continua prevalecendo', () => {
    expect(buildVisibilityWhere({
      userId: uid, role: UserRole.GERENTE, poolEnabled: false, ownOnly: true, managerFullAccess: true,
    })).toEqual({ responsavel_id: uid });
  });
});

describe('buildMessageScope — acesso total do gestor', () => {
  const privadoDoVendedor: MessageScopeLead = {
    responsavel_id: 'u-vendedor',
    instancia_whatsapp: 'inst-vendedor',
    assumed_at: new Date('2026-01-01'),
    is_private: true,
  };
  const ctx = (over: Partial<MessageScopeCtx> = {}): MessageScopeCtx => ({
    userId: uid,
    role: 'SUPER_ADMIN',
    focusMode: false,
    shareHistoryEnabled: false,
    poolEnabled: false,
    ownConversationIds: [],
    ownedInstances: [],
    managerFullAccess: true,
    ...over,
  });

  it('gestor lê a conversa inteira de lead privado de outro', () => {
    expect(buildMessageScope(privadoDoVendedor, ctx())).toEqual({});
  });

  it('sem a flag, o privado de outro segue fechado até para o gerente', () => {
    expect(buildMessageScope(privadoDoVendedor, ctx({ role: 'GERENTE', managerFullAccess: false }))).toBeNull();
  });

  it('em modo foco o gestor volta à regra normal', () => {
    expect(buildMessageScope(privadoDoVendedor, ctx({ focusMode: true }))).toBeNull();
  });

  it('operador não é afetado pela flag', () => {
    expect(buildMessageScope(privadoDoVendedor, ctx({ role: 'OPERADOR' }))).toBeNull();
  });
});
