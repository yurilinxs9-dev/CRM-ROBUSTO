import { MessagesService } from './messages.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import type { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * `GET messages/history/:leadId` tinha o MESMO vazamento que o chat
 * (`LeadsService.getMessages`): para o dono do card o filtro era `{}` — todas
 * as instâncias, sem olhar `pool_enabled`. Aqui o que importa é o `where`
 * entregue a `message.findMany`, com a regra espelhada do getMessages.
 */

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000005';

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
      }),
    },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ pool_enabled: args.poolEnabled }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ focus_mode: args.focusMode }),
    },
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
    message: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const media: any = { getSignedUrl: jest.fn().mockResolvedValue('https://signed/x') };
  const service = new MessagesService(
    {} as any, // http
    { get: jest.fn().mockReturnValue('') } as any, // config
    prisma,
    media,
    {} as any, // audio
    { emitNewMessage: jest.fn() } as any, // gateway
    {} as any, // cache
    {} as any, // mediaPipeline
    { add: jest.fn() } as any, // sendQueue
    {} as any, // outboundWebhooks
    {} as any, // push
    {} as any, // conversations
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

function capturedWhere(prisma: any): Prisma.MessageWhereInput {
  expect(prisma.message.findMany).toHaveBeenCalled();
  return prisma.message.findMany.mock.calls[0][0].where as Prisma.MessageWhereInput;
}

describe('MessagesService.getHistory — corte do modo INDIVIDUAL', () => {
  it('DISCRIMINANTE: INDIVIDUAL — dono OPERADOR vê só as conversas dele', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: false,
      responsavelId: 'u-alex',
      ownConversationIds: ['conv-alex'],
      ownedInstances: ['inst-alex'],
    });

    await service.getHistory(LEAD_ID, user('u-alex', UserRole.OPERADOR));

    expect(capturedWhere(prisma)).toEqual({
      lead_id: LEAD_ID,
      tenant_id: 't1',
      OR: [
        { conversation_id: { in: ['conv-alex'] } },
        { conversation_id: null, instance_name: { in: ['inst-alex'] } },
      ],
    });
  });

  it('INDIVIDUAL — GERENTE sem foco vê tudo (filtro vazio)', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: false,
      responsavelId: 'u-alex',
    });

    await service.getHistory(LEAD_ID, user('u-ger', UserRole.GERENTE));

    expect(capturedWhere(prisma)).toEqual({ lead_id: LEAD_ID, tenant_id: 't1' });
  });

  it('DISCRIMINANTE: INDIVIDUAL — GERENTE focado em lead de OUTRO responsável não lê nada', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: true,
      responsavelId: 'u-alex',
      ownConversationIds: [],
      ownedInstances: ['inst-ger'],
    });

    const res = await service.getHistory(LEAD_ID, user('u-ger', UserRole.GERENTE));

    expect(res).toEqual({ messages: [], nextCursor: undefined });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('INDIVIDUAL — GERENTE focado em lead SEM dono vê tudo (insumo da distribuição)', async () => {
    const { service, prisma } = makeService({
      poolEnabled: false,
      focusMode: true,
      responsavelId: null,
    });

    await service.getHistory(LEAD_ID, user('u-ger', UserRole.GERENTE));

    expect(capturedWhere(prisma)).toEqual({ lead_id: LEAD_ID, tenant_id: 't1' });
  });

  it('REGRESSÃO: COMPARTILHADO — dono OPERADOR segue vendo a conversa inteira', async () => {
    const { service, prisma } = makeService({
      poolEnabled: true,
      focusMode: false,
      responsavelId: 'u-alex',
    });

    await service.getHistory(LEAD_ID, user('u-alex', UserRole.OPERADOR));

    expect(capturedWhere(prisma)).toEqual({ lead_id: LEAD_ID, tenant_id: 't1' });
  });
});
