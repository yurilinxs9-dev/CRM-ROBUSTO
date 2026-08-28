import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import type { Prisma } from '@prisma/client';

/**
 * O bug original do modo INDIVIDUAL: o dono do card via, no chat, as conversas
 * de TODAS as instâncias do lead — inclusive as de outros vendedores. Aqui o
 * que importa é o `where` entregue a `message.findMany` (o corte por conversa)
 * e o gate que devolve lista vazia.
 */

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000004';

type MakeArgs = {
  poolEnabled: boolean;
  focusMode: boolean;
  responsavelId: string | null;
  ownConversationIds?: string[];
  ownedInstances?: string[];
};

function makeService(args: MakeArgs) {
  const prisma: any = {
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        responsavel_id: args.responsavelId,
        instancia_whatsapp: 'inst-A',
        is_private: false,
        assumed_at: null,
      }),
    },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({
        share_history_enabled: false,
        pool_enabled: args.poolEnabled,
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ focus_mode: args.focusMode }),
    },
    message: { findMany: jest.fn().mockResolvedValue([]) },
    conversation: {
      findMany: jest
        .fn()
        .mockResolvedValue((args.ownConversationIds ?? ['conv-own']).map((id) => ({ id }))),
    },
    whatsappInstance: {
      findMany: jest
        .fn()
        .mockResolvedValue((args.ownedInstances ?? ['inst-own']).map((nome) => ({ nome }))),
    },
  };
  const media: any = { getSignedUrl: jest.fn().mockResolvedValue('https://signed/x') };
  const service = new LeadsService(
    prisma,
    {} as any, // instances
    {} as any, // cache
    {} as any, // gateway
    media,
    {} as any, // push
    {} as any, // outboundWebhooks
    {} as any, // assignment
    {} as any, // customFields
    {} as any, // autoActionsQueue
  );
  return { service, prisma };
}

const user = (id: string, role: UserRole): AuthUser => ({
  id,
  nome: id,
  email: `${id}@x.com`,
  role: role as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
});

/** O AND de escopos passado ao findMany (vazio quando o scope foi null). */
function capturedScopes(prisma: any): Prisma.MessageWhereInput[] {
  expect(prisma.message.findMany).toHaveBeenCalled();
  const where = prisma.message.findMany.mock.calls[0][0].where;
  return (where.AND ?? []) as Prisma.MessageWhereInput[];
}

function hasConversationCut(scopes: Prisma.MessageWhereInput[]): boolean {
  return scopes.some((s) =>
    (s.OR ?? []).some(
      (branch: Prisma.MessageWhereInput) => 'conversation_id' in branch,
    ),
  );
}

describe('LeadsService.getMessages — corte do modo INDIVIDUAL', () => {
  it('DISCRIMINANTE: INDIVIDUAL — dono OPERADOR do lead vê só as conversas dele', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: false,
      responsavelId: 'u-alex',
      ownConversationIds: ['conv-alex'],
      ownedInstances: ['inst-alex'],
    });

    await service.getMessages(LEAD_ID, user('u-alex', UserRole.OPERADOR));

    const scopes = capturedScopes(prisma);
    expect(hasConversationCut(scopes)).toBe(true);
    expect(scopes).toContainEqual({
      OR: [
        { conversation_id: { in: ['conv-alex'] } },
        { conversation_id: null, instance_name: { in: ['inst-alex'] } },
      ],
    });
  });

  it('INDIVIDUAL — GERENTE sem foco vê tudo (sem corte por conversa)', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: false,
      responsavelId: 'u-alex',
    });

    const res = await service.getMessages(LEAD_ID, user('u-ger', UserRole.GERENTE));

    expect(res.messages).toEqual([]);
    expect(hasConversationCut(capturedScopes(prisma))).toBe(false);
  });

  it('DISCRIMINANTE: INDIVIDUAL — GERENTE focado em lead de OUTRO responsável não lê nada', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: true,
      responsavelId: 'u-alex',
      ownConversationIds: [],
      ownedInstances: ['inst-ger'],
    });

    const res = await service.getMessages(LEAD_ID, user('u-ger', UserRole.GERENTE));

    expect(res).toEqual({ messages: [], nextCursor: undefined });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('INDIVIDUAL — GERENTE focado em lead SEM dono vê tudo (insumo da distribuição)', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: true,
      responsavelId: null,
    });

    await service.getMessages(LEAD_ID, user('u-ger', UserRole.GERENTE));

    expect(hasConversationCut(capturedScopes(prisma))).toBe(false);
  });

  it('DISCRIMINANTE: INDIVIDUAL — GERENTE focado que É o responsável vê só as conversas dele', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: true,
      responsavelId: 'u-ger',
      ownConversationIds: ['conv-ger'],
      ownedInstances: ['inst-ger'],
    });

    const res = await service.getMessages(LEAD_ID, user('u-ger', UserRole.GERENTE));

    // Passa o gate por ser o responsável, mas sem visão total: no INDIVIDUAL o
    // gerente focado lê como operador — só as conversas próprias.
    expect(res.messages).toEqual([]);
    expect(capturedScopes(prisma)).toContainEqual({
      OR: [
        { conversation_id: { in: ['conv-ger'] } },
        { conversation_id: null, instance_name: { in: ['inst-ger'] } },
      ],
    });
  });

  it('REGRESSÃO: COMPARTILHADO — dono OPERADOR segue vendo a conversa inteira', async () => {
    const { service, prisma } = makeService({
      poolEnabled: true,
      focusMode: false,
      responsavelId: 'u-alex',
    });

    await service.getMessages(LEAD_ID, user('u-alex', UserRole.OPERADOR));

    expect(hasConversationCut(capturedScopes(prisma))).toBe(false);
  });
});
