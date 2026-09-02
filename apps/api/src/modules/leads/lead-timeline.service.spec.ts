import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LeadTimelineService } from './lead-timeline.service';
import { codificarCursor, decodificarCursor, SESSAO_MAX_MENSAGENS } from './lead-timeline';
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
    task: {
      // Duas leituras (criadas por created_at, concluidas por completed_at);
      // o mock imita o where `completed_at: { not: null }` da segunda.
      findMany: jest.fn().mockImplementation(({ orderBy }: any) =>
        Promise.resolve(
          orderBy.completed_at
            ? (f.tarefas ?? []).filter((t: any) => t.completed_at)
            : (f.tarefas ?? []),
        ),
      ),
    },
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

  it('toda fonte recorta por lead e tenant', async () => {
    const { service, prisma } = make();
    await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 10 });
    const recorte = { lead_id: LEAD_ID, tenant_id: 't1' };
    expect(whereMensagem(prisma, false)).toMatchObject(recorte);
    expect(whereMensagem(prisma, true)).toMatchObject(recorte);
    expect(prisma.leadActivity.findMany.mock.calls[0][0].where).toMatchObject(recorte);
    expect(prisma.task.findMany.mock.calls[0][0].where).toMatchObject(recorte);
    expect(prisma.task.findMany.mock.calls[1][0].where).toMatchObject(recorte);
    expect(prisma.leadLembrete.findMany.mock.calls[0][0].where).toMatchObject(recorte);
  });

  it('tarefa antiga concluida ontem aparece como :concluida na primeira pagina', async () => {
    // A leitura de criadas (created_at desc) corta a tarefa antiga no `take`.
    // So a segunda leitura, ordenada por completed_at, salva o evento.
    const tarefa = (id: string, criada: string, concluida: string | null) => ({
      id,
      titulo: id,
      tipo: 'LIGACAO',
      status: concluida ? 'CONCLUIDA' : 'PENDENTE',
      scheduled_at: T(criada),
      completed_at: concluida ? T(concluida) : null,
      created_at: T(criada),
      responsavel: null,
    });
    const { service } = make({
      tarefas: [
        tarefa('nova2', '2026-09-01T12:00:00Z', null),
        tarefa('nova1', '2026-09-01T11:00:00Z', null),
        tarefa('nova0', '2026-09-01T10:00:00Z', null),
        tarefa('antiga', '2020-01-01T09:00:00Z', '2026-09-01T13:00:00Z'),
      ],
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 2 });
    expect(r.items.map((i) => `${i.id}@${i.quando}`)).toEqual([
      'antiga:concluida@2026-09-01T13:00:00.000Z',
      'nova2:criada@2026-09-01T12:00:00.000Z',
    ]);
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
    expect(prisma.task.findMany.mock.calls[0][0].where.created_at).toEqual({ lte });
    expect(prisma.task.findMany.mock.calls[1][0].where.completed_at).toEqual({
      not: null,
      lte,
    });
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
    expect(prisma.task.findMany.mock.calls[0][0].where.created_at).toBeUndefined();
    expect(prisma.task.findMany.mock.calls[1][0].where.completed_at).toEqual({ not: null });
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
      if (where.created_at && where.created_at.lte) {
        // Com `lte` o lote reenvia a propria m3 (fronteira inclusiva); o
        // service tem que descarta-la pelo id antes de calcular o corte.
        return Promise.resolve([
          msg('m3', '2026-09-01T12:00:00Z'),
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

  it('empate de milissegundo: a irma de mesmo timestamp da ultima lida entra', async () => {
    const prisma: any = {
      message: { findMany: jest.fn() },
      leadActivity: { findMany: jest.fn().mockResolvedValue([]) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      leadLembrete: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma.message.findMany.mockImplementation(({ where }: any) => {
      if (where.is_internal_note === true) return Promise.resolve([]);
      if (where.created_at && where.created_at.lte) {
        // m3b nasceu no MESMO milissegundo de m3. Com `lt` ela jamais seria
        // lida e a sessao sairia com 3 mensagens em vez de 4.
        return Promise.resolve([
          msg('m3', '2026-09-01T12:00:00Z'),
          msg('m3b', '2026-09-01T12:00:00Z'),
          msg('m4', '2026-09-01T09:00:00Z'),
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
    expect(sessao.tipo === 'sessao' && sessao.total).toBe(4);
    expect(sessao.tipo === 'sessao' && sessao.primeira_mensagem_id).toBe('m3b');
  });
});

/**
 * Galeria de midia: mesmo gate e mesmo recorte do chat, mas paginacao por id
 * (nao por data) — a ordem e estavel e o cursor nao precisa de desempate.
 */
describe('LeadTimelineService.getMedia', () => {
  const midia = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'IMAGE',
    media_url: `path/${id}.jpg`,
    media_mimetype: 'image/jpeg',
    media_filename: null,
    media_thumbnail_path: null,
    media_duration_seconds: null,
    direction: 'INCOMING',
    created_at: T('2026-09-01T12:00:00Z'),
    ...extra,
  });

  it('filtra tipos de midia, exclui notas, aplica scope e assina URL', async () => {
    const { service, prisma } = make({
      mensagens: [midia('m1')],
      scope: { AND: [{ conversation_id: { in: ['c1'] } }] },
    });
    const r = await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    const where = prisma.message.findMany.mock.calls[0][0].where;
    expect(where.type).toEqual({ in: ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] });
    expect(where.is_internal_note).toBe(false);
    expect(where.AND).toEqual([{ conversation_id: { in: ['c1'] } }]);
    expect(r.items[0].media_url).toBe('signed:path/m1.jpg');
    expect(r.items[0].created_at).toBe('2026-09-01T12:00:00.000Z');
    expect(r.nextCursor).toBeUndefined();
  });

  // Midia arquivada pelo cleanup de 30 dias perde `media_url` e fica so com a
  // thumbnail; ela precisa sair ASSINADA, senao a galeria mostra tile vazio.
  it('assina a thumbnail e nao vaza o path cru de storage', async () => {
    const { service } = make({
      mensagens: [midia('m1', { media_url: null, media_thumbnail_path: 'thumbs/m1.jpg' })],
    });
    const r = await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    expect(r.items[0].media_thumbnail_url).toBe('signed:thumbs/m1.jpg');
    expect(r.items[0].media_url).toBeNull();
    expect(r.items[0]).not.toHaveProperty('media_thumbnail_path');
  });

  it('sem thumbnail o campo assinado sai null', async () => {
    const { service } = make({ mensagens: [midia('m1')] });
    const r = await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    expect(r.items[0].media_thumbnail_url).toBeNull();
  });

  // Sem este OR entrariam linhas sem `media_url` E sem thumbnail — tile vazio.
  it('le so o que a galeria consegue desenhar e desempata por id', async () => {
    const { service, prisma } = make({ mensagens: [midia('m1')] });
    await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    const args = prisma.message.findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { media_url: { not: null } },
      { media_thumbnail_path: { not: null } },
    ]);
    expect(args.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
  });

  // Fronteira de seguranca: sem lead_id + tenant_id no where, o recorte do
  // chat sozinho deixaria vazar midia de outro lead ou de outra empresa.
  it('o where carrega lead_id e tenant_id', async () => {
    const { service, prisma } = make({ mensagens: [midia('m1')] });
    await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    const where = prisma.message.findMany.mock.calls[0][0].where;
    expect(where.lead_id).toBe(LEAD_ID);
    expect(where.tenant_id).toBe('t1');
  });

  it('scope null devolve vazio sem consultar', async () => {
    const { service, prisma } = make({ scope: null });
    const r = await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeUndefined();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('o gate roda antes da leitura de midia', async () => {
    const { service, prisma } = make({ findOne: () => Promise.reject(new ForbiddenException()) });
    await expect(
      service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('cursor por id com skip 1 e nextCursor no limit+1', async () => {
    const { service, prisma } = make({ mensagens: [midia('m0'), midia('m1'), midia('m2')] });
    const r = await service.getMedia(LEAD_ID, user(UserRole.GERENTE), {
      cursor: 'm-prev',
      limit: 2,
    });
    const args = prisma.message.findMany.mock.calls[0][0];
    expect(args.cursor).toEqual({ id: 'm-prev' });
    expect(args.skip).toBe(1);
    expect(args.take).toBe(3);
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBe('m1');
  });

  it('sem cursor nao manda cursor nem skip pro Prisma', async () => {
    const { service, prisma } = make({ mensagens: [midia('m1')] });
    await service.getMedia(LEAD_ID, user(UserRole.OPERADOR), { limit: 40 });
    const args = prisma.message.findMany.mock.calls[0][0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });
});

/**
 * F1: a fonte de mensagens tem horizonte proprio (`mensagensAntes`), diferente
 * do `cursor.quando` das fontes por data. Se a pagina desce ABAIXO da mensagem
 * mais antiga lida, as sessoes remontadas na pagina seguinte nascem com
 * `quando` MAIOR que o cursor e o filtro do cursor as apaga para sempre.
 */
describe('LeadTimelineService.getTimeline — clamp no horizonte de mensagens', () => {
  const msg = (id: string, iso: string) => ({
    id,
    created_at: T(iso),
    direction: 'INCOMING',
    type: 'TEXT',
    content: id,
    instance_name: 'inst-A',
  });
  const atividade = (id: string, iso: string) => ({
    id,
    tipo: 'lead_updated',
    descricao: '',
    dados_antes: null,
    dados_depois: null,
    created_at: T(iso),
    user: null,
  });

  // limit+1 mensagens recentes (a fonte de sessoes fica com temMais) contra
  // atividades MUITO mais velhas que a mensagem mais antiga lida.
  const RECENTES = [
    msg('m4', '2026-09-01T12:30:00Z'),
    msg('m3', '2026-09-01T12:20:00Z'),
    msg('m2', '2026-09-01T12:10:00Z'),
    msg('m1', '2026-09-01T12:00:00Z'),
  ];
  const ANTIGAS = [
    atividade('a3', '2026-08-01T10:00:00Z'),
    atividade('a2', '2026-08-01T09:00:00Z'),
    atividade('a1', '2026-08-01T08:00:00Z'),
  ];
  const HORIZONTE = '2026-09-01T12:00:00.000Z';

  it('pagina 1 para no horizonte: as atividades antigas nao entram', async () => {
    const { service } = make({ mensagens: RECENTES, atividades: ANTIGAS });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { limit: 3 });
    expect(r.items.map((i) => i.id)).toEqual(['sessao-m1']);
    expect(decodificarCursor(r.nextCursor ?? '')).toEqual({
      quando: '2026-09-01T12:30:00.000Z',
      id: 'sessao-m1',
      mensagensAntes: HORIZONTE,
    });
  });

  it('pagina 2 traz a sessao antiga E as atividades adiadas', async () => {
    const cursor = codificarCursor({
      quando: '2026-09-01T12:30:00.000Z',
      id: 'sessao-m1',
      mensagensAntes: HORIZONTE,
    });
    const { service } = make({
      // Com `lt: mensagensAntes` a leitura seguinte so alcanca estas.
      mensagens: [msg('m0b', '2026-08-15T10:05:00Z'), msg('m0', '2026-08-15T10:00:00Z')],
      atividades: ANTIGAS,
    });
    const r = await service.getTimeline(LEAD_ID, user(UserRole.GERENTE), { cursor, limit: 3 });
    expect(r.items.map((i) => i.id)).toEqual(['sessao-m0', 'a3', 'a2']);
  });

  it('o fechamento da sessao para no teto de SESSAO_MAX_MENSAGENS', async () => {
    // Conversa infinita sem gap: sem o teto o while leria o lead inteiro.
    const t0 = Date.parse('2026-09-01T12:00:00.000Z');
    const LOTE = 50;
    const emSequencia = (quantidade: number, aPartirDe: number) =>
      Array.from({ length: quantidade }, (_, i) => {
        const at = aPartirDe - (i + 1) * 60_000;
        return msg(`m-${at}`, new Date(at).toISOString());
      });
    const prisma: any = {
      message: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          if (where.is_internal_note === true) return Promise.resolve([]);
          const lte = where.created_at?.lte;
          if (lte) return Promise.resolve(emSequencia(LOTE, lte.getTime()));
          return Promise.resolve([
            msg(`m-${t0}`, new Date(t0).toISOString()),
            ...emSequencia(2, t0),
          ]);
        }),
      },
      leadActivity: { findMany: jest.fn().mockResolvedValue([]) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      leadLembrete: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
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
    const lotes = prisma.message.findMany.mock.calls.filter(
      (c: any[]) => c[0].where.created_at?.lte,
    );
    expect(lotes).toHaveLength(SESSAO_MAX_MENSAGENS / LOTE);
    const sessao = r.items[0];
    expect(sessao.tipo === 'sessao' && sessao.total).toBe(SESSAO_MAX_MENSAGENS);
    expect(sessao.tipo === 'sessao' && sessao.truncada).toBe(true);
  });
});
