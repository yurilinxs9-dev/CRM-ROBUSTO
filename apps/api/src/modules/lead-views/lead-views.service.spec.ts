import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadViewsService } from './lead-views.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Filtro salvo é configuração de tela, mas mora numa tabela multi-tenant e o
 * corpo vem cru do cliente. Os dois riscos:
 *
 * 1. Editar/apagar view de OUTRA pessoa. Filtrar só por tenant_id não basta —
 *    dois operadores do mesmo workspace mexeriam na barra lateral um do outro.
 * 2. Gravar qualquer coisa na coluna Json. O que entra aqui volta depois como
 *    query string da listagem; chave desconhecida tem que ser descartada.
 */

const TENANT = 'tenant-1';

const user: AuthUser = {
  id: 'u1',
  nome: 'Operador',
  email: 'o@x.com',
  role: UserRole.OPERADOR as never,
  ativo: true,
  tenantId: TENANT,
};

function makeService(over: Record<string, any> = {}) {
  const prisma: any = {
    leadView: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 'v1' }),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'v-novo', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'v1', ...data })),
      delete: jest.fn().mockResolvedValue({}),
      ...(over.leadView ?? {}),
    },
  };
  return { service: new LeadViewsService(prisma), prisma };
}

describe('LeadViewsService', () => {
  describe('findAll', () => {
    it('lista as proprias e as compartilhadas, nunca a de outro usuario', () => {
      const { service, prisma } = makeService();
      void service.findAll(user);

      expect(prisma.leadView.findMany.mock.calls[0][0].where).toEqual({
        tenant_id: TENANT,
        OR: [{ user_id: 'u1' }, { user_id: null }],
      });
    });
  });

  describe('create', () => {
    it('nome vazio e recusado', async () => {
      const { service } = makeService();
      await expect(service.create(user, { nome: '  ' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('grava no tenant e com o dono correto', async () => {
      const { service, prisma } = makeService();
      await service.create(user, { nome: 'Meus quentes', filtros: { tags: ['QUENTE'] } });

      const data = prisma.leadView.create.mock.calls[0][0].data;
      expect(data.tenant_id).toBe(TENANT);
      expect(data.user_id).toBe('u1');
    });

    it('compartilhada nasce sem dono', async () => {
      const { service, prisma } = makeService();
      await service.create(user, { nome: 'Do time', compartilhada: true });

      expect(prisma.leadView.create.mock.calls[0][0].data.user_id).toBeNull();
    });

    /** O recorte que impede a coluna Json de virar depósito do que o cliente mandar. */
    it('descarta chave desconhecida e mantem so o que o painel entende', async () => {
      const { service, prisma } = makeService();
      await service.create(user, {
        nome: 'X',
        filtros: {
          tags: ['A', ''],
          valor_min: ' 100 ',
          chave_inventada: 'xxx',
          __proto__: 'nope',
          tarefa: '',
        },
      });

      expect(prisma.leadView.create.mock.calls[0][0].data.filtros).toEqual({
        tags: ['A'],
        valor_min: '100',
      });
    });

    it('filtros ausente ou nao-objeto vira objeto vazio', async () => {
      const { service, prisma } = makeService();
      await service.create(user, { nome: 'X', filtros: 'lixo' });
      expect(prisma.leadView.create.mock.calls[0][0].data.filtros).toEqual({});
    });
  });

  describe('update / remove', () => {
    it('confere tenant E autoria antes de escrever', async () => {
      const { service, prisma } = makeService();
      await service.update(user, 'v1', { nome: 'Novo nome' });

      expect(prisma.leadView.findFirst.mock.calls[0][0].where).toEqual({
        id: 'v1',
        tenant_id: TENANT,
        OR: [{ user_id: 'u1' }, { user_id: null }],
      });
    });

    it('view de outro usuario vira 404 e nao chega no update', async () => {
      const { service, prisma } = makeService({
        leadView: { findFirst: jest.fn().mockResolvedValue(null) },
      });

      await expect(service.update(user, 'v-do-colega', { nome: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.leadView.update).not.toHaveBeenCalled();
    });

    it('view de outro usuario vira 404 e nao chega no delete', async () => {
      const { service, prisma } = makeService({
        leadView: { findFirst: jest.fn().mockResolvedValue(null) },
      });

      await expect(service.remove(user, 'v-do-colega')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.leadView.delete).not.toHaveBeenCalled();
    });

    it('update sem filtros nao apaga os filtros que ja estavam la', async () => {
      const { service, prisma } = makeService();
      await service.update(user, 'v1', { nome: 'So o nome' });

      expect(prisma.leadView.update.mock.calls[0][0].data).toEqual({ nome: 'So o nome' });
    });
  });
});
