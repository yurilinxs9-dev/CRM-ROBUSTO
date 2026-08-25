import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
 * 3. View compartilhada é da equipe inteira — só gestor mexe nela.
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

const operador = user;

const gerente: AuthUser = {
  ...user,
  id: 'g1',
  nome: 'Gerente',
  email: 'g@x.com',
  role: UserRole.GERENTE as never,
};

function makeService(over: Record<string, any> = {}) {
  const prisma: any = {
    leadView: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 'v1', user_id: 'u1' }),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'v-novo', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'v1', ...data })),
      delete: jest.fn().mockResolvedValue({}),
      ...(over.leadView ?? {}),
    },
    customFieldDef: {
      findMany: jest.fn().mockResolvedValue([{ key: 'x_cnpj' }]),
      ...(over.customFieldDef ?? {}),
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
      await service.create(gerente, { nome: 'Do time', compartilhada: true });

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

  describe('sanitizacao da config de view', () => {
    it('grava config valida', async () => {
      const { service, prisma } = makeService();
      await service.create(gerente, {
        nome: 'Minha lista',
        tipo_padrao: 'lista',
        sort: { campo: 'valor_estimado', dir: 'desc' },
        colunas: [{ key: 'nome', width: 240 }, { key: 'x_cnpj' }, { key: 'estagio' }],
        card_fields: ['valor_estimado', 'tags'],
      });

      const data = prisma.leadView.create.mock.calls[0][0].data;
      expect(data.tipo_padrao).toBe('lista');
      expect(data.sort).toEqual({ campo: 'valor_estimado', dir: 'desc' });
      expect(data.colunas).toEqual([{ key: 'nome', width: 240 }, { key: 'x_cnpj' }, { key: 'estagio' }]);
      expect(data.card_fields).toEqual(['valor_estimado', 'tags']);
    });

    it('descarta chave desconhecida, sort fora da whitelist e clampa width', async () => {
      const { service, prisma } = makeService();
      await service.create(gerente, {
        nome: 'Suja',
        tipo_padrao: 'grafico',
        sort: { campo: 'x_cnpj', dir: 'desc' }, // custom nao e ordenavel
        colunas: [{ key: 'nao_existe' }, { key: 'nome', width: 9000 }],
        card_fields: ['nao_existe', 'telefone'],
      });

      const data = prisma.leadView.create.mock.calls[0][0].data;
      expect(data.tipo_padrao).toBe('kanban');
      expect(data.sort).toEqual({});
      expect(data.colunas).toEqual([{ key: 'nome', width: 640 }]);
      expect(data.card_fields).toEqual(['telefone']);
    });

    /**
     * O menu de colunas do front oferece as derivadas do `mapRow` (ultima
     * mensagem, nao lidas, tarefas pendentes). Se a whitelist do backend nao
     * conhecer essas chaves, o save responde 200 e devolve a config sem elas —
     * a coluna some sozinha depois do toast de sucesso.
     */
    it('mantem as pseudo-colunas derivadas da listagem em colunas e card_fields', async () => {
      const { service, prisma } = makeService();
      await service.create(gerente, {
        nome: 'Derivadas',
        colunas: [
          { key: 'ultimo_mensagem', width: 300 },
          { key: 'mensagens_nao_lidas' },
          { key: 'pending_tasks_count' },
        ],
        card_fields: ['pending_tasks_count'],
      });

      const data = prisma.leadView.create.mock.calls[0][0].data;
      expect(data.colunas).toEqual([
        { key: 'ultimo_mensagem', width: 300 },
        { key: 'mensagens_nao_lidas' },
        { key: 'pending_tasks_count' },
      ]);
      expect(data.card_fields).toEqual(['pending_tasks_count']);
    });

    /** Renderizar a derivada e uma coisa; ordenar por ela o Prisma nao sabe fazer. */
    it('nao aceita pseudo-coluna derivada como campo de ordenacao', async () => {
      const { service, prisma } = makeService();
      await service.create(gerente, {
        nome: 'Sort derivado',
        sort: { campo: 'mensagens_nao_lidas', dir: 'desc' },
      });

      expect(prisma.leadView.create.mock.calls[0][0].data.sort).toEqual({});
    });

    /** Chave repetida vira key duplicada no React depois; a primeira ocorrencia manda. */
    it('descarta chave repetida em colunas e card_fields', async () => {
      const { service, prisma } = makeService();
      await service.create(gerente, {
        nome: 'Repetida',
        colunas: [{ key: 'nome', width: 240 }, { key: 'estagio' }, { key: 'nome', width: 100 }],
        card_fields: ['telefone', 'tags', 'telefone'],
      });

      const data = prisma.leadView.create.mock.calls[0][0].data;
      expect(data.colunas).toEqual([{ key: 'nome', width: 240 }, { key: 'estagio' }]);
      expect(data.card_fields).toEqual(['telefone', 'tags']);
    });

    /** Sem teto, o cliente entope a coluna Json com milhares de entradas validas. */
    it('trunca as listas em 100 entradas', async () => {
      const { service, prisma } = makeService({
        customFieldDef: {
          findMany: jest
            .fn()
            .mockResolvedValue(Array.from({ length: 300 }, (_, i) => ({ key: `x_${i}` }))),
        },
      });

      await service.create(gerente, {
        nome: 'Gigante',
        colunas: Array.from({ length: 300 }, (_, i) => ({ key: `x_${i}` })),
        card_fields: Array.from({ length: 300 }, (_, i) => `x_${i}`),
      });

      const data = prisma.leadView.create.mock.calls[0][0].data;
      expect(data.colunas).toHaveLength(100);
      expect(data.card_fields).toHaveLength(100);
      expect(data.colunas[99]).toEqual({ key: 'x_99' });
      expect(data.card_fields[99]).toBe('x_99');
    });

    it('so consulta campos custom ativos do tenant no escopo LEAD', async () => {
      const { service, prisma } = makeService();
      await service.create(gerente, { nome: 'X' });

      expect(prisma.customFieldDef.findMany.mock.calls[0][0].where).toEqual({
        tenant_id: TENANT,
        escopo: 'LEAD',
        active: true,
      });
    });

    it('update so grava a config presente no corpo', async () => {
      const { service, prisma } = makeService();
      await service.update(user, 'v1', { colunas: [{ key: 'nome' }] });

      expect(prisma.leadView.update.mock.calls[0][0].data).toEqual({
        colunas: [{ key: 'nome' }],
      });
    });
  });

  describe('view compartilhada exige gestor', () => {
    it('OPERADOR nao cria compartilhada', async () => {
      const { service, prisma } = makeService();
      await expect(
        service.create(operador, { nome: 'Time', compartilhada: true }),
      ).rejects.toThrow('Apenas gestores');
      expect(prisma.leadView.create).not.toHaveBeenCalled();
    });

    it('OPERADOR nao edita view compartilhada', async () => {
      const { service, prisma } = makeService({
        leadView: { findFirst: jest.fn().mockResolvedValue({ id: 'v1', user_id: null }) },
      });

      await expect(service.update(operador, 'v1', { nome: 'Novo' })).rejects.toThrow(
        'Apenas gestores',
      );
      expect(prisma.leadView.update).not.toHaveBeenCalled();
    });

    it('OPERADOR nao apaga view compartilhada', async () => {
      const { service, prisma } = makeService({
        leadView: { findFirst: jest.fn().mockResolvedValue({ id: 'v1', user_id: null }) },
      });

      await expect(service.remove(operador, 'v1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.leadView.delete).not.toHaveBeenCalled();
    });

    it('GERENTE pode', async () => {
      const { service } = makeService();
      await expect(service.create(gerente, { nome: 'Time', compartilhada: true })).resolves.toBeDefined();
    });

    it('GERENTE edita view compartilhada', async () => {
      const { service, prisma } = makeService({
        leadView: { findFirst: jest.fn().mockResolvedValue({ id: 'v1', user_id: null }) },
      });

      await service.update(gerente, 'v1', { nome: 'Novo' });
      expect(prisma.leadView.update).toHaveBeenCalled();
    });

    it('OPERADOR continua editando a propria view pessoal', async () => {
      const { service, prisma } = makeService();
      await service.update(operador, 'v1', { nome: 'Minha' });
      expect(prisma.leadView.update).toHaveBeenCalled();
    });
  });
});
