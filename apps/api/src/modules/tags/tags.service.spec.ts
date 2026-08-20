import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TagsService } from './tags.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * O seletor de tags do lead cria a tag no mesmo gesto em que o usuário digita
 * um nome novo. Isso põe dois riscos em cima deste serviço:
 *
 * 1. Nome repetido não pode virar erro. Dois atendentes digitando a mesma tag
 *    ao mesmo tempo é o caso normal, e antes o segundo levava P2002 — na tela,
 *    erro para uma ação que do ponto de vista dele deu certo.
 * 2. Excluir tag é um DELETE por id vindo do cliente. Sem o filtro por tenant,
 *    id adivinhado apaga tag de outro workspace.
 */

const TENANT = 'tenant-1';
const OUTRO_TENANT = 'tenant-2';

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
    tag: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }: any) =>
        Promise.resolve({ id: 'tag-nova', ...create }),
      ),
      delete: jest.fn().mockResolvedValue({}),
      ...(over.tag ?? {}),
    },
  };
  return { service: new TagsService(prisma), prisma };
}

describe('TagsService', () => {
  describe('create', () => {
    it('usa upsert na unique (tenant_id, nome) — nome repetido devolve a existente, nao estoura', async () => {
      const { service, prisma } = makeService();

      await service.create(user, 'QUENTE', '#4CAF7D');

      expect(prisma.tag.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.tag.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ tenant_id_nome: { tenant_id: TENANT, nome: 'QUENTE' } });
      // update vazio: reusar o nome nao pode repintar a cor que ja estava la.
      expect(arg.update).toEqual({});
    });

    it('grava sempre no tenant de quem chamou', async () => {
      const { service, prisma } = makeService();

      await service.create(user, 'COBERTURA', '#3E7BD6');

      expect(prisma.tag.upsert.mock.calls[0][0].create.tenant_id).toBe(TENANT);
    });

    it('apara espacos em volta do nome', async () => {
      const { service, prisma } = makeService();

      await service.create(user, '   ADESAO   ', '#D95A7E');

      expect(prisma.tag.upsert.mock.calls[0][0].create.nome).toBe('ADESAO');
    });

    it('nome vazio ou so espacos e recusado antes de tocar no banco', async () => {
      const { service, prisma } = makeService();

      await expect(service.create(user, '   ', '#fff')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tag.upsert).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('apaga a tag do proprio tenant', async () => {
      const { service, prisma } = makeService({
        tag: { findFirst: jest.fn().mockResolvedValue({ id: 'tag-1' }) },
      });

      await service.remove(user, 'tag-1');

      expect(prisma.tag.findFirst.mock.calls[0][0].where).toEqual({
        id: 'tag-1',
        tenant_id: TENANT,
      });
      expect(prisma.tag.delete).toHaveBeenCalledWith({ where: { id: 'tag-1' } });
    });

    /**
     * O teste que importa. `findFirst` devolve null porque a tag e de outro
     * tenant; o servico tem que parar em 404 e NUNCA chamar delete — um delete
     * por id cru enxerga a tabela inteira.
     */
    it('tag de outro tenant vira 404 e nao chega no delete', async () => {
      const { service, prisma } = makeService({
        tag: { findFirst: jest.fn().mockResolvedValue(null) },
      });

      await expect(service.remove(user, 'tag-do-vizinho')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.tag.delete).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('lista so as tags do tenant, em ordem alfabetica', async () => {
      const { service, prisma } = makeService();

      await service.findAll(user);

      const arg = prisma.tag.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ tenant_id: TENANT });
      expect(arg.orderBy).toEqual({ nome: 'asc' });
      expect(arg.where.tenant_id).not.toBe(OUTRO_TENANT);
    });
  });
});
