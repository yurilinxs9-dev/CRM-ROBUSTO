import { Reflector } from '@nestjs/core';
import { PlatformAdminController } from './platform-admin.controller';
import { AiConfigController } from '../ai/ai-config.controller';
import { PLATFORM_SCOPE_KEY } from './platform-scopes.decorator';

const reflector = new Reflector();
const scopeOf = (handler: unknown) => reflector.get<string | undefined>(PLATFORM_SCOPE_KEY, handler as never);

describe('mapa rota → escopo', () => {
  const proto = PlatformAdminController.prototype;

  it('saúde exige escopo health', () => {
    expect(scopeOf(proto.health)).toBe('health');
  });

  it('avisos exigem escopo announcements', () => {
    expect(scopeOf(proto.listAnnouncements)).toBe('announcements');
    expect(scopeOf(proto.createAnnouncement)).toBe('announcements');
    expect(scopeOf(proto.setActive)).toBe('announcements');
  });

  it('rotas de risco continuam sem escopo, ou seja, só do master', () => {
    // Sem metadata => o guard exige '*'. Se alguém decorar uma destas por
    // engano, o admin restrito ganha impersonate/exclusão — o teste trava isso.
    for (const h of [
      proto.stats,
      proto.tenants,
      proto.tenant,
      proto.logs,
      proto.banUser,
      proto.deleteUser,
      proto.deleteTenant,
      proto.suspendTenant,
      proto.impersonate,
    ]) {
      expect(scopeOf(h)).toBeUndefined();
    }
  });

  it('painel de IA exige escopo ai no controller inteiro', () => {
    expect(reflector.get<string | undefined>(PLATFORM_SCOPE_KEY, AiConfigController)).toBe('ai');
  });
});
