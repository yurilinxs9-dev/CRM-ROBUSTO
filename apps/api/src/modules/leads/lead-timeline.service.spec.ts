import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LeadTimelineService } from './lead-timeline.service';
import { codificarCursor } from './lead-timeline';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000004';
const T = (iso: string) => new Date(iso);

const user = (role: UserRole, id = 'u-1'): AuthUser => ({
  id,
  nome: id,
  email: `${id}@x.com`,
  role: role as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
});

type Fontes = {
  mensagens?: unknown[];
  notas?: unknown[];
  atividades?: unknown[];
  tarefas?: unknown[];
  lembretes?: unknown[];
  scope?: Record<string, unknown> | null;
  findOne?: () => Promise<unknown>;
};

function make(f: Fontes = {}) {
  const prisma: any = {
    message: {
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.is_internal_note === true ? (f.notas ?? []) : (f.mensagens ?? [])),
      ),
    },
    leadActivity: { findMany: jest.fn().mockResolvedValue(f.atividades ?? []) },
    task: { findMany: jest.fn().mockResolvedValue(f.tarefas ?? []) },
    leadLembrete: { findMany: jest.fn().mockResolvedValue(f.lembretes ?? []) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u-2', nome: 'Isamara' }]) },
  };
  const leads: any = {
    findOne: jest.fn().mockImplementation(
      f.findOne ??
        (() =>
          Promise.resolve({
            id: LEAD_ID,
            responsavel_id: 'u-1',
            instancia_whatsapp: 'inst-A',
            assumed_at: null,
            is_private: false,
          })),
    ),
    messageScopeFor: jest.fn().mockResolvedValue(f.scope === undefined ? {} : f.scope),
    resolveMediaUrl: jest
      .fn()
      .mockImplementation((u: string | null) => Promise.resolve(u ? `signed:${u}` : null)),
  };
  return { service: new LeadTimelineService(prisma, leads), prisma, leads };
}

/** `where` da leitura de mensagens: sessoes (false) ou notas internas (true). */
function whereMensagem(prisma: any, notaInterna: boolean): any {
  const chamada = prisma.message.findMany.mock.calls.find(
    (c: any[]) => c[0].where.is_internal_note === notaInterna,
  );
  if (!chamada) throw new Error(`nenhuma leitura com is_internal_note=${notaInterna}`);
  return chamada[0].where;
}

describe('LeadTimelineService.getTimeline — acesso', () => {
  it('lead de outro tenant: findOne lanca 404 e a timeline propaga', async () => {
    const { service } = make({ findOne: () => Promise.reject(new NotFoundException()) });
    await expect(
      service.getTimeline(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('operador sem acesso: findOne lanca 403 e a timeline propaga', async () => {
    const { service } = make({ findOne: () => Promise.reject(new ForbiddenException()) });
    await expect(
      service.getTimeline(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('o gate roda antes de qualquer leitura de fonte', async () => {
    const { service, prisma } = make({ findOne: () => Promise.reject(new ForbiddenException()) });
    await expect(
      service.getTimeline(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(prisma.leadActivity.findMany).not.toHaveBeenCalled();
    expect(prisma.task.findMany).not.toHaveBeenCalled();
    expect(prisma.leadLembrete.findMany).not.toHaveBeenCalled();
  });

  it('scope null: nenhuma mensagem nem nota, mas atividades continuam', async () => {
    const { service, prisma } = make({
      scope: null,
      atividades: [
        {
          id: 'a1',
          tipo: 'stage_change',
          descricao: 'x',
          dados_antes: null,
          dados_depois: null,
          created_at: T('2026-09-01T10:00:00Z'),
          user: null,
        },
      ],
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.VISUALIZADOR), { limit: 40 });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(r.items.map((i) => i.tipo)).toEqual(['atividade']);
  });

  it('cursor ilegivel vira 400', async () => {
    const { service } = make();
    await expect(
      service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { cursor: 'nao-e-cursor', limit: 40 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('LeadTimelineService.getTimeline — mescla', () => {
  it('ordena por quando, notas fora das sessoes, tarefa concluida gera 2 itens', async () => {
    const { service } = make({
      mensagens: [
        {
          id: 'm2',
          created_at: T('2026-09-01T12:10:00Z'),
          direction: 'OUTGOING',
          type: 'TEXT',
          content: 'ok',
          instance_name: 'inst-A',
        },
        {
          id: 'm1',
          created_at: T('2026-09-01T12:00:00Z'),
          direction: 'INCOMING',
          type: 'TEXT',
          content: 'oi',
          instance_name: 'inst-A',
        },
      ],
      notas: [
        {
          id: 'n1',
          created_at: T('2026-09-01T12:05:00Z'),
          content: 'cliente quer @Isamara',
          sent_by: { id: 'u-1', nome: 'Yuri' },
          metadata: { mentions: ['u-2'] },
        },
      ],
      tarefas: [
        {
          id: 't1',
          titulo: 'Ligar',
          tipo: 'LIGACAO',
          status: 'CONCLUIDA',
          scheduled_at: T('2026-09-01T09:00:00Z'),
          completed_at: T('2026-09-01T13:00:00Z'),
          created_at: T('2026-09-01T08:00:00Z'),
          responsavel: { id: 'u-1', nome: 'Yuri' },
        },
      ],
      lembretes: [
        {
          id: 'l1',
          motivo: 'pediu retorno',
          avisar_em: T('2026-09-03T09:00:00Z'),
          status: 'pendente',
          origem: 'ia',
          created_at: T('2026-09-01T12:20:00Z'),
        },
      ],
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 40 });
    expect(r.items.map((i) => `${i.tipo}:${i.quando}`)).toEqual([
      'tarefa:2026-09-01T13:00:00.000Z',
      'lembrete:2026-09-01T12:20:00.000Z',
      'sessao:2026-09-01T12:10:00.000Z',
      'nota:2026-09-01T12:05:00.000Z',
      'tarefa:2026-09-01T08:00:00.000Z',
    ]);
    const sessao = r.items.find((i) => i.tipo === 'sessao');
    expect(sessao && sessao.tipo === 'sessao' && sessao.total).toBe(2);
    const nota = r.items.find((i) => i.tipo === 'nota');
    expect(nota && nota.tipo === 'nota' && nota.mencoes).toEqual([{ id: 'u-2', nome: 'Isamara' }]);
    expect(r.nextCursor).toBeUndefined();
  });

  it('mencao so resolve dentro do tenant', async () => {
    const { service, prisma } = make({
      notas: [
        {
          id: 'n1',
          created_at: T('2026-09-01T12:05:00Z'),
          content: '@Isamara',
          sent_by: null,
          metadata: { mentions: ['u-2', 'u-9'] },
        },
      ],
    });
    await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 40 });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['u-2', 'u-9'] },
      tenant_id: 't1',
    });
  });

  it('cursor: fontes por data leem com lte; mensagens com lt de mensagensAntes', async () => {
    const { service, prisma } = make();
    const quando = '2026-09-01T12:00:00.000Z';
    const mensagensAntes = '2026-09-01T11:30:00.000Z';
    await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), {
      cursor: codificarCursor({ quando, id: 'x-1', mensagensAntes }),
      limit: 10,
    });
    const lte = new Date(quando);
    expect(prisma.leadActivity.findMany.mock.calls[0][0].where.created_at).toEqual({ lte });
    expect(prisma.leadLembrete.findMany.mock.calls[0][0].where.created_at).toEqual({ lte });
    expect(prisma.task.findMany.mock.calls[0][0].where.OR).toEqual([
      { created_at: { lte } },
      { completed_at: { lte } },
    ]);
    expect(whereMensagem(prisma, true).created_at).toEqual({ lte });
    expect(whereMensagem(prisma, false).created_at).toEqual({ lt: new Date(mensagensAntes) });
  });

  it('cursor sem mensagensAntes: sessoes ficam sem limite superior', async () => {
    const { service, prisma } = make();
    await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), {
      cursor: codificarCursor({ quando: '2026-09-01T12:00:00.000Z', id: 'x-1' }),
      limit: 10,
    });
    expect(whereMensagem(prisma, false).created_at).toBeUndefined();
  });

  it('sem cursor: nenhuma fonte ganha limite superior', async () => {
    const { service, prisma } = make();
    await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 10 });
    expect(prisma.leadActivity.findMany.mock.calls[0][0].where.created_at).toBeUndefined();
    expect(prisma.task.findMany.mock.calls[0][0].where.OR).toBeUndefined();
    expect(whereMensagem(prisma, false).created_at).toBeUndefined();
  });

  it('o item exatamente no cursor nao repete na pagina seguinte', async () => {
    const base = {
      tipo: 'lead_updated',
      descricao: '',
      dados_antes: null,
      dados_depois: null,
      created_at: T('2026-09-01T11:00:00Z'),
      user: null,
    };
    const { service } = make({ atividades: [{ ...base, id: 'a2' }, { ...base, id: 'a1' }] });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), {
      cursor: codificarCursor({ quando: '2026-09-01T11:00:00.000Z', id: 'a2' }),
      limit: 40,
    });
    expect(r.items.map((i) => i.id)).toEqual(['a1']);
  });

  it('tarefa concluida: com cursor no meio, so o evento anterior ao cursor entra', async () => {
    const { service } = make({
      tarefas: [
        {
          id: 't1',
          titulo: 'Ligar',
          tipo: 'LIGACAO',
          status: 'CONCLUIDA',
          scheduled_at: T('2026-09-01T09:00:00Z'),
          completed_at: T('2026-09-01T13:00:00Z'),
          created_at: T('2026-09-01T08:00:00Z'),
          responsavel: null,
        },
      ],
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), {
      cursor: codificarCursor({ quando: '2026-09-01T10:00:00.000Z', id: 'zzz' }),
      limit: 40,
    });
    expect(r.items.map((i) => `${i.id}@${i.quando}`)).toEqual([
      't1:criada@2026-09-01T08:00:00.000Z',
    ]);
  });

  it('nextCursor aparece quando alguma fonte devolveu limit+1', async () => {
    // Prisma devolve desc; o mock imita isso (o service confia no orderBy).
    const atividades = [2, 1, 0].map((i) => ({
      id: `a${i}`,
      tipo: 'lead_updated',
      descricao: '',
      dados_antes: null,
      dados_depois: null,
      created_at: T(`2026-09-01T1${i}:00:00Z`),
      user: null,
    }));
    const { service } = make({ atividades });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBe(codificarCursor({ quando: '2026-09-01T11:00:00.000Z', id: 'a1' }));
  });

  it('nextCursor com sessao carrega mensagensAntes = inicio da sessao mais antiga', async () => {
    const { service } = make({
      mensagens: [
        {
          id: 'm2',
          created_at: T('2026-09-01T12:10:00Z'),
          direction: 'OUTGOING',
          type: 'TEXT',
          content: 'ok',
          instance_name: 'inst-A',
        },
        {
          id: 'm1',
          created_at: T('2026-09-01T12:00:00Z'),
          direction: 'INCOMING',
          type: 'TEXT',
          content: 'oi',
          instance_name: 'inst-A',
        },
      ],
      atividades: [
        {
          id: 'a1',
          tipo: 'lead_updated',
          descricao: '',
          dados_antes: null,
          dados_depois: null,
          created_at: T('2026-09-01T09:00:00Z'),
          user: null,
        },
      ],
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 1 });
    expect(r.items.map((i) => i.tipo)).toEqual(['sessao']);
    expect(r.nextCursor).toBe(
      codificarCursor({
        quando: '2026-09-01T12:10:00.000Z',
        id: 'sessao-m1',
        mensagensAntes: '2026-09-01T12:00:00.000Z',
      }),
    );
  });
});

describe('LeadTimelineService.getTimeline — fechamento da sessao cortada', () => {
  const msg = (id: string, iso: string) => ({
    id,
    created_at: T(iso),
    direction: 'INCOMING',
    type: 'TEXT',
    content: id,
    instance_name: 'inst-A',
  });

  it('le lotes extras ate o gap de 30 min, para a sessao nao cortar no take', async () => {
    // O primeiro lote (limit+1 = 3) termina no meio de uma sessao; o lote de
    // fechamento traz mais duas da mesma sessao e uma ja fora do gap.
    const prisma: any = {
      message: { findMany: jest.fn() },
      leadActivity: { findMany: jest.fn().mockResolvedValue([]) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      leadLembrete: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma.message.findMany.mockImplementation(({ where }: any) => {
      if (where.is_internal_note === true) return Promise.resolve([]);
      if (where.created_at && where.created_at.lt) {
        return Promise.resolve([
          msg('m4', '2026-09-01T11:50:00Z'),
          msg('m5', '2026-09-01T11:45:00Z'),
          msg('m6', '2026-09-01T09:00:00Z'),
        ]);
      }
      return Promise.resolve([
        msg('m1', '2026-09-01T12:10:00Z'),
        msg('m2', '2026-09-01T12:05:00Z'),
        msg('m3', '2026-09-01T12:00:00Z'),
      ]);
    });
    const leads: any = {
      findOne: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        responsavel_id: 'u-1',
        instancia_whatsapp: 'inst-A',
        assumed_at: null,
        is_private: false,
      }),
      messageScopeFor: jest.fn().mockResolvedValue({}),
    };
    const service = new LeadTimelineService(prisma, leads);
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 2 });
    const sessao = r.items[0];
    // m1..m5 sao a mesma sessao; m6 (gap de 2h45) ficou de fora.
    expect(sessao.tipo === 'sessao' && sessao.total).toBe(5);
    expect(sessao.tipo === 'sessao' && sessao.inicio).toBe('2026-09-01T11:45:00.000Z');
    // O cursor aponta para o inicio real da sessao, nao para o corte do take.
    expect(r.nextCursor).toBe(
      codificarCursor({
        quando: '2026-09-01T12:10:00.000Z',
        id: 'sessao-m5',
        mensagensAntes: '2026-09-01T11:45:00.000Z',
      }),
    );
  });
});
