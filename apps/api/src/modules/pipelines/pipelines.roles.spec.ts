import 'reflect-metadata';
import { PipelinesController } from './pipelines.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';

/**
 * O RolesGuard e hierarquico (>=): @Roles(OPERADOR) admite OPERADOR, GERENTE e
 * SUPER_ADMIN e barra so VISUALIZADOR. Criar etapa e trabalho do dia a dia do
 * operador (pedido do dono, 27/08); o resto do modulo continua GERENTE por ser
 * estrutural/destrutivo.
 */
function rolesDe(metodo: string): UserRole[] | undefined {
  const handler = Object.getOwnPropertyDescriptor(PipelinesController.prototype, metodo)?.value as
    | object
    | undefined;
  if (!handler) throw new Error(`metodo ${metodo} nao existe no controller`);
  return Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined;
}

describe('PipelinesController — papeis por rota', () => {
  it.each([
    'createStage',
    'removeStage',
    'removeStageWithMove',
    'updateStage',
    'reorderStages',
  ])('ciclo de etapa do dia a dia e liberado para OPERADOR (todo tenant): %s', (metodo) => {
    expect(rolesDe(metodo)).toEqual([UserRole.OPERADOR]);
  });

  it.each(['create', 'update', 'remove', 'deleteWithMove'])(
    'rota de FUNIL %s continua exigindo GERENTE',
    (metodo) => {
    expect(rolesDe(metodo)).toEqual([UserRole.GERENTE]);
  });
});
