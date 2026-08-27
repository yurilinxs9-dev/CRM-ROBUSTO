import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PlatformAdminController } from './platform-admin.controller';
import { AiConfigController } from '../ai/ai-config.controller';
import { PLATFORM_SCOPE_KEY, type PlatformScope } from './platform-scopes.decorator';

const reflector = new Reflector();
const scopeOf = (handler: unknown) => reflector.get<string | undefined>(PLATFORM_SCOPE_KEY, handler as never);

/**
 * Mapa completo rota → escopo. O admin restrito tem TODOS os escopos nomeados,
 * então nenhuma rota fica sem decorator: rota sem decorator é rota só do master
 * (fail-closed no guard), e isso passou a ser exceção, não regra.
 */
const EXPECTED: Record<string, PlatformScope> = {
  stats: 'overview',
  tenants: 'tenants',
  tenant: 'tenants',
  logs: 'logs',
  health: 'health',
  // Saúde das instâncias é leitura de operação, irmã do `health`.
  instancesHealth: 'health',
  banUser: 'tenant_actions',
  deleteUser: 'tenant_actions',
  deleteTenant: 'tenant_actions',
  suspendTenant: 'tenant_actions',
  setBilling: 'tenant_actions',
  markPaid: 'tenant_actions',
  // Leitura: alimenta os KPIs da tela de clientes, então acompanha `tenants`.
  billingSummary: 'tenants',
  impersonate: 'tenant_actions',
  startHistorySync: 'tenant_actions',
  listAnnouncements: 'announcements',
  createAnnouncement: 'announcements',
  setActive: 'announcements',
};

/** Handlers de rota do controller = métodos com metadata de path do Nest. */
function routeHandlerNames(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof desc?.value !== 'function') return false;
    return Reflect.getMetadata('path', desc.value) !== undefined;
  });
}

describe('mapa rota → escopo', () => {
  const proto = PlatformAdminController.prototype;

  it.each(Object.entries(EXPECTED))('%s exige escopo %s', (handler, scope) => {
    expect(scopeOf(proto[handler as keyof typeof proto])).toBe(scope);
  });

  it('nenhuma rota fica de fora do mapa', () => {
    // Rota nova sem @PlatformScopes fica invisível para o admin restrito e passa
    // batido numa revisão. O teste força a decisão explícita.
    expect(routeHandlerNames(proto).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('painel de IA exige escopo ai no controller inteiro', () => {
    expect(reflector.get<string | undefined>(PLATFORM_SCOPE_KEY, AiConfigController)).toBe('ai');
  });
});
