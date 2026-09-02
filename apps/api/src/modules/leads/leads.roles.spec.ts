import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LeadsController } from './leads.controller';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';

/**
 * Finding 1 da revisão final: `GET /leads/export` era a ÚNICA rota de escrita/
 * extração do controller sem `@Roles`. O clamp de dentro do `exportCsv` só
 * estreita para `UserRole.OPERADOR`, então quem entrava como VISUALIZADOR caía
 * no ramo "sem clamp" e baixava o tenant inteiro em CSV — leitura, sim, mas de
 * TODA a base, telefone por telefone.
 *
 * Fix: `@Roles(UserRole.OPERADOR)`. O RolesGuard é hierárquico (>=), então
 * OPERADOR/GERENTE/SUPER_ADMIN passam e só VISUALIZADOR é barrado — mesmo
 * critério das rotas irmãs (bulk/*, create, update).
 *
 * Teste no nível do guard (e não do metadado só) pra provar o efeito: o
 * VISUALIZADOR nem chega no service.
 */

function handlerDe(metodo: keyof LeadsController): object {
  const descriptor = Object.getOwnPropertyDescriptor(
    LeadsController.prototype,
    metodo as string,
  );
  const handler = descriptor?.value as object | undefined;
  if (!handler) throw new Error(`metodo ${String(metodo)} nao existe no controller`);
  return handler;
}

function contextoDe(metodo: keyof LeadsController, role: UserRole): ExecutionContext {
  const handler = handlerDe(metodo);
  return {
    getHandler: () => handler,
    getClass: () => LeadsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u-1', role } }) }),
  } as unknown as ExecutionContext;
}

const guard = () => new RolesGuard(new Reflector());

describe('LeadsController — GET /leads/export exige pelo menos OPERADOR', () => {
  it('a rota declara @Roles(OPERADOR)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, handlerDe('exportCsv'))).toEqual([
      UserRole.OPERADOR,
    ]);
  });

  it('VISUALIZADOR é barrado pelo guard antes de chegar no service', () => {
    expect(() => guard().canActivate(contextoDe('exportCsv', UserRole.VISUALIZADOR))).toThrow(
      ForbiddenException,
    );
  });

  it.each([UserRole.OPERADOR, UserRole.GERENTE, UserRole.SUPER_ADMIN])(
    '%s continua exportando (hierarquia >=)',
    (role) => {
      expect(guard().canActivate(contextoDe('exportCsv', role))).toBe(true);
    },
  );
});

/**
 * Ficha do lead (Task 3+): rotas de LEITURA. `@Roles(VISUALIZADOR)` explicito
 * — o RolesGuard e hierarquico (>=), entao todo mundo passa e o recorte fino
 * (lead privado, operador sem acesso, mensagens fora do escopo) fica com o
 * service. Sem o decorator a rota herdaria o default do controller, e a
 * intencao "quem so olha tambem le a timeline" ficaria implicita.
 */
describe('LeadsController — rotas de leitura da ficha (VISUALIZADOR passa)', () => {
  const rotas = ['getTimeline', 'getMedia'] as const;
  it.each(rotas)('%s declara @Roles(VISUALIZADOR)', (metodo) => {
    expect(Reflect.getMetadata(ROLES_KEY, handlerDe(metodo))).toEqual([UserRole.VISUALIZADOR]);
  });
  const papeis = [
    UserRole.VISUALIZADOR,
    UserRole.OPERADOR,
    UserRole.GERENTE,
    UserRole.SUPER_ADMIN,
  ];
  // Metadado nao basta: o guard e quem barra, entao a prova e por rota E papel.
  const casos = rotas.flatMap((metodo) => papeis.map((role) => [metodo, role] as const));
  it.each(casos)('%s: %s passa no guard', (metodo, role) => {
    expect(guard().canActivate(contextoDe(metodo, role))).toBe(true);
  });
});
