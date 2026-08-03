import { MessagesService } from './messages.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Gap: sendText/sendAudio/sendMedia persist Message rows with no
 * conversation_id — the outbound path never adopted Conversation (Task 4).
 * This blocks the planned migration that makes Message.conversation_id
 * NOT NULL (see docs/specs/conversa-por-instancia.md).
 *
 * These specs exercise `sendText()` for real (mocked Prisma + mocked
 * ConversationService) and pin three things:
 *  1. the create payload carries the conversation_id ConversationService
 *     resolved — a DISTINCT, recognisable value, not an echo of test input;
 *  2. resolveForInbound is called with isFromMe: true — outbound sends must
 *     never advance last_customer_message_at (that would let an outbound/
 *     automated message steal the lead from the conversation the customer
 *     is actually talking to);
 *  3. the instanceName passed to resolveForInbound is the SAME value the
 *     message is stamped with, including the auto-swap case where the
 *     lead's preferred instance is offline and a live fallback is used.
 */

function makeMocks() {
  const prisma: any = {
    lead: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    conversation: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ pool_enabled: false }),
      findUnique: jest.fn().mockResolvedValue({ pool_enabled: false, prefix_enabled: false }),
    },
    whatsappInstance: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    message: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      ),
    },
  };
  const http: any = {};
  const config: any = { get: jest.fn().mockReturnValue('') };
  const media: any = {};
  const audio: any = {};
  const gateway: any = { emitNewMessage: jest.fn() };
  const cache: any = {};
  const mediaPipeline: any = {};
  const sendQueue: any = { add: jest.fn().mockResolvedValue(undefined) };
  const outboundWebhooks: any = { dispatchMessageCreated: jest.fn().mockResolvedValue(undefined) };
  const push: any = {};
  // Distinct, recognisable value — not derived from any test input, so an
  // assertion that merely echoes back what the test supplied can't pass by
  // accident.
  const conversations: any = {
    resolveForInbound: jest.fn().mockResolvedValue({
      id: 'CONV-RESOLVED-3f9a',
      responsavel_id: null,
    }),
  };
  return {
    prisma, http, config, media, audio, gateway, cache, mediaPipeline,
    sendQueue, outboundWebhooks, push, conversations,
  };
}

function makeService() {
  const m = makeMocks();
  const service = new MessagesService(
    m.http,
    m.config,
    m.prisma,
    m.media,
    m.audio,
    m.gateway,
    m.cache,
    m.mediaPipeline,
    m.sendQueue,
    m.outboundWebhooks,
    m.push,
    m.conversations,
  );
  return { service, ...m };
}

const LEAD_ID = '369354c4-b4d6-4bb1-93c0-0afeedc1450e';

const baseLead = {
  id: LEAD_ID,
  tenant_id: 't1',
  telefone: '5511999990000',
  is_private: false,
  proximo_followup: null,
  cadence_step_index: 0,
  responsavel_id: 'u-alex' as string | null,
  instancia_whatsapp: 'inst-A',
};

const liveInstance = (nome: string, ownerId: string | null = null) => ({
  id: `wa-${nome}`,
  nome,
  status: 'connected',
  owner_user_id: ownerId,
  config: { uazapi_token: 'tok' },
});

const alex: AuthUser = {
  id: 'u-alex',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

describe('MessagesService.sendText — conversation_id no envio de saída', () => {
  it('grava a mensagem com o conversation_id devolvido por resolveForInbound', async () => {
    const { service, prisma, conversations } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) =>
      where.nome === 'inst-A' ? Promise.resolve(liveInstance('inst-A', 'u-alex')) : Promise.resolve(null),
    );

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ conversation_id: 'CONV-RESOLVED-3f9a' }),
      }),
    );
  });

  it('chama resolveForInbound com isFromMe: true (nunca rouba a conversa ativa do cliente)', async () => {
    const { service, prisma, conversations } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) =>
      where.nome === 'inst-A' ? Promise.resolve(liveInstance('inst-A', 'u-alex')) : Promise.resolve(null),
    );

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect(conversations.resolveForInbound).toHaveBeenCalledWith(
      expect.objectContaining({ isFromMe: true }),
    );
  });

  it('instanceName passado a resolveForInbound é o MESMO gravado em Message.instance_name, mesmo no auto-swap', async () => {
    const { service, prisma, conversations } = makeService();
    // Individual: instância preferida do lead está morta/de outro dono →
    // auto-swap pra instância viva do próprio Alex.
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, instancia_whatsapp: 'inst-morta' });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) => {
      if (where.nome === 'inst-morta') return Promise.resolve(null);
      if (where.owner_user_id === 'u-alex') return Promise.resolve(liveInstance('inst-alex-propria', 'u-alex'));
      return Promise.resolve(null);
    });

    const result = await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect((result as any).instance_name).toBe('inst-alex-propria');
    expect(conversations.resolveForInbound).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: 'inst-alex-propria' }),
    );
  });
});
